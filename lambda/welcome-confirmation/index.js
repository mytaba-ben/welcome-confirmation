require('dotenv').config();
const Airtable = require('airtable');
const twilio = require('twilio');
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const crypto = require('crypto');

// ==================== CONFIGURATION ====================
const CONFIG = {
  airtable: {
    apiKey: process.env.AIRTABLE_API_KEY,
    baseId: process.env.AIRTABLE_BASE_ID,
    tables: {
      orderInfo: process.env.AIRTABLE_ORDER_INFO_TABLE_ID,
      customer: process.env.AIRTABLE_CUSTOMER_TABLE_ID
    }
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID
  },
  confirmation: {
    baseUrl: process.env.CONFIRMATION_ENDPOINT_BASE_URL
  },
  alerts: {
    email: process.env.ALERT_EMAIL,
    fromEmail: process.env.FROM_EMAIL
  },
  timezone: process.env.TIMEZONE || 'America/Los_Angeles'
};

// ==================== AIRTABLE CLIENT ====================
const base = new Airtable({ apiKey: CONFIG.airtable.apiKey }).base(CONFIG.airtable.baseId);

/**
 * Get all records from a table with optional filter
 */
async function getAllRecords(tableId, filterFormula = null) {
  const selectOptions = {
    maxRecords: 1000
  };
  if (filterFormula) {
    selectOptions.filterByFormula = filterFormula;
  }
  
  return new Promise((resolve, reject) => {
    base(tableId).select(selectOptions).firstPage((err, records) => {
      if (err) {
        console.error(`getAllRecords error: ${err.message}`);
        reject(err);
      } else {
        const mapped = records.map(r => ({ id: r.id, ...r.fields }));
        console.log(`getAllRecords: fetched ${mapped.length} records`);
        resolve(mapped);
      }
    });
  });
}

/**
 * Get a single record by ID
 */
async function getRecord(tableId, recordId) {
  try {
    const record = await base(tableId).find(recordId);
    return { id: record.id, ...record.fields };
  } catch (error) {
    console.error(`Error fetching record ${recordId}:`, error.message);
    return null;
  }
}

/**
 * Update a record in Airtable
 */
async function updateRecord(tableId, recordId, fields) {
  try {
    await base(tableId).update(recordId, fields);
    console.log(`✅ Updated record ${recordId}`);
    return true;
  } catch (error) {
    console.error(`Error updating record ${recordId}:`, error.message);
    return false;
  }
}

// ==================== TWILIO CLIENT ====================
let twilioClient = null;

/**
 * Initialize Twilio client
 */
function initTwilio() {
  if (!CONFIG.twilio.accountSid || CONFIG.twilio.accountSid === 'your_twilio_account_sid_here') {
    console.log('⚠️  Twilio not configured - SMS sending disabled');
    return null;
  }
  
  try {
    twilioClient = twilio(CONFIG.twilio.accountSid, CONFIG.twilio.authToken);
    console.log('✅ Twilio client initialized');
    return twilioClient;
  } catch (error) {
    console.error('❌ Failed to initialize Twilio:', error.message);
    return null;
  }
}

/**
 * Send SMS via Twilio
 */
async function sendSMS(to, message, shortenUrls = false) {
  if (!twilioClient) {
    console.log(`📱 [MOCK SMS] To: ${to}`);
    console.log(`📝 Message: ${message.substring(0, 50)}...`);
    return { success: false, mock: true, error: 'Twilio not configured' };
  }
  
  try {
    const messageParams = {
      body: message,
      to: to,
      messagingServiceSid: CONFIG.twilio.messagingServiceSid,
      shortenUrls: shortenUrls
    };
    
    const result = await twilioClient.messages.create(messageParams);
    console.log(`✅ SMS queued: ${result.sid}`);
    return { success: true, sid: result.sid };
  } catch (error) {
    console.error(`❌ Failed to send SMS:`, error.message);
    return { success: false, error: error.message, errorCode: error.code };
  }
}

// ==================== TOKEN & URL GENERATION ====================

/**
 * Generate a unique confirmation token
 */
function generateConfirmationToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Build confirmation URL from token
 */
function buildConfirmationUrl(token) {
  return `${CONFIG.confirmation.baseUrl}/${token}`;
}

/**
 * Format event date in readable format
 */
function formatEventDate(dateString) {
  if (!dateString) return 'your event';
  
  try {
    const date = new Date(dateString);
    const options = { weekday: 'long', month: 'long', day: 'numeric' };
    return date.toLocaleDateString('en-US', options);
  } catch (error) {
    console.error('Error formatting date:', dateString, error);
    return 'your event';
  }
}

// ==================== TIMEZONE HANDLING ====================

/**
 * Get current time in Pacific timezone
 */
function getCurrentTimeInPacific() {
  return new Date().toLocaleString('en-US', { timeZone: CONFIG.timezone });
}

/**
 * Check if current time is 9 AM or later in Pacific timezone
 */
function isAfter9AM_Pacific() {
  const now = new Date();
  const pacificTime = new Date(now.toLocaleString('en-US', { timeZone: CONFIG.timezone }));
  return pacificTime.getHours() >= 9;
}

/**
 * Check if event date is today (in Pacific timezone)
 */
function isEventToday(eventDateString) {
  if (!eventDateString) return false;
  
  try {
    const eventDate = new Date(eventDateString);
    const now = new Date();
    
    // Get today's date in Pacific timezone using proper conversion
    const formatter = new Intl.DateTimeFormat('en-US', { 
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    
    const parts = formatter.formatToParts(now);
    const todayYear = parseInt(parts.find(p => p.type === 'year').value);
    const todayMonth = parseInt(parts.find(p => p.type === 'month').value) - 1; // 0-indexed
    const todayDate = parseInt(parts.find(p => p.type === 'day').value);
    
    return eventDate.getFullYear() === todayYear &&
           eventDate.getMonth() === todayMonth &&
           eventDate.getDate() === todayDate;
  } catch (error) {
    console.error('Error checking event date:', error);
    return false;
  }
}

// ==================== EMAIL ALERTS ====================
const sesClient = new SESv2Client({ region: process.env.AWS_REGION || 'us-west-2' });

/**
 * Send failure alert email
 */
async function sendAlertEmail(customerInfo, messageContent, errorInfo, recordInfo) {
  const emailBody = `
Truvay SMS Confirmation Failed

Customer Information:
- Name: ${customerInfo.name || 'N/A'}
- Phone: ${customerInfo.phone}
- Email: ${customerInfo.email || 'N/A'}

Message Details:
- Order ID: ${recordInfo.orderId}
- Event Date: ${recordInfo.eventDate}
- Message Content:
${messageContent}

Twilio Error:
- Error Code: ${errorInfo.errorCode || 'N/A'}
- Description: ${errorInfo.errorMessage || 'No description available'}
- Message SID: ${errorInfo.sid || 'N/A'}

Airtable Record: https://airtable.com/${CONFIG.airtable.baseId}/${CONFIG.airtable.tables.orderInfo}/${recordInfo.airtableRecordId}

Action Required: Please contact the customer via email or alternative method.
`;

  const command = new SendEmailCommand({
    FromEmailAddress: CONFIG.alerts.fromEmail,
    Destination: {
      ToAddresses: [CONFIG.alerts.email]
    },
    Content: {
      Simple: {
        Subject: {
          Data: `Truvay SMS Confirmation Failed - ${customerInfo.name || customerInfo.phone}`
        },
        Body: {
          Text: {
            Data: emailBody
          }
        }
      }
    }
  });

  try {
    await sesClient.send(command);
    console.log(`📧 Alert email sent to ${CONFIG.alerts.email}`);
    return true;
  } catch (error) {
    console.error('❌ Failed to send alert email:', error.message);
    return false;
  }
}

// ==================== SMS TEMPLATES ====================

function getWelcomeConfirmationTemplate(eventDate, confirmationUrl) {
  return `Welcome to Truvay! You're booked for your Truvay Night Out on ${eventDate}.

Please confirm you received this message by tapping the link below:
${confirmationUrl}

If we don't receive your confirmation, we may send you both email and text notifications during your Truvay Night Out to ensure delivery of your event details.

Need help? Reply HELP to connect with our live concierge team via WhatsApp. Reply STOP to opt out of text messages - if you opt out, all event instructions will be sent to your email instead.`;
}

function getReminderTemplate(confirmationUrl) {
  return `We didn't receive confirmation of our earlier text. Please tap the link to confirm you receive texts: ${confirmationUrl}. Otherwise, you'll receive event updates via email and text today.`;
}

// ==================== MAIN PROCESSING LOGIC ====================



/**
 * Process new orders and send initial confirmation SMS
 */
async function processNewOrders() {
  console.log('\n\n========== STARTING processNewOrders ==========');
  
  try {
    console.log('Step 1: Fetching all records from Airtable');
    const allRecords = await getAllRecords(CONFIG.airtable.tables.orderInfo);
    
    // Filter manually in JavaScript
    const pendingOrders = allRecords.filter(order => 
      !order.sms_confirmation_sent_date && order.paid
    );
    
    const newOrders = pendingOrders;
    console.log(`Step 2: Found ${newOrders.length} orders needing initial confirmation SMS`);
    
    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    
    for (const order of pendingOrders) {
      const {
        id: orderId,
        link_customer,
        event_date,
        paid,
        sms_confirmation_sent_date,
        sms_confirmation_status
      } = order;
      
      // Skip if not paid
      if (!paid) {
        console.log(`⏭️  Skipping order ${orderId}: not paid`);
        skippedCount++;
        continue;
      }
      
      // Skip if already sent
      if (sms_confirmation_sent_date) {
        console.log(`⏭️  Skipping order ${orderId}: already sent`);
        skippedCount++;
        continue;
      }
      
      // Skip if already confirmed
      if (sms_confirmation_status === 'confirmed') {
        console.log(`⏭️  Skipping order ${orderId}: already confirmed`);
        skippedCount++;
        continue;
      }
      
      // Get primary customer
      const primaryCustomerId = Array.isArray(link_customer) ? link_customer[0] : link_customer;
      if (!primaryCustomerId) {
        console.log(`⏭️  Skipping order ${orderId}: no primary customer`);
        skippedCount++;
        continue;
      }
      
      const customer = await getRecord(CONFIG.airtable.tables.customer, primaryCustomerId);
      if (!customer) {
        console.log(`⏭️  Skipping order ${orderId}: customer not found`);
        skippedCount++;
        continue;
      }
      
      const { phone_number, first_name, last_name, email } = customer;
      if (!phone_number) {
        console.log(`⏭️  Skipping order ${orderId}: no phone number`);
        skippedCount++;
        continue;
      }
      
      if (!event_date) {
        console.log(`⏭️  Skipping order ${orderId}: no event date`);
        skippedCount++;
        continue;
      }
      
      // Generate token and URL
      const token = generateConfirmationToken();
      const confirmationUrl = buildConfirmationUrl(token);
      const formattedDate = formatEventDate(event_date);
      
      // Compose SMS
      const smsBody = getWelcomeConfirmationTemplate(formattedDate, confirmationUrl);
      
      console.log(`\n📱 Sending confirmation SMS to ${phone_number}...`);
      const smsResult = await sendSMS(phone_number, smsBody, true);
      
      if (smsResult.success) {
        // Update Airtable with token, SID, date, and status
        const now = new Date();
        // Convert to Pacific Time and format as YYYY-MM-DD for Airtable date field
        const pacificTimeString = now.toLocaleString('en-US', { 
          timeZone: 'America/Los_Angeles',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        });
        // Format is MM/DD/YYYY, convert to YYYY-MM-DD
        const [month, day, year] = pacificTimeString.split('/');
        const dateOnly = `${year}-${month}-${day}`;
        
        const updateFields = {
          sms_confirmation_link_token: token,
          sms_confirmation_twilio_sid: smsResult.sid,
          sms_confirmation_sent_date: dateOnly,
          sms_confirmation_status: 'pending'
        };
        
        const updated = await updateRecord(CONFIG.airtable.tables.orderInfo, orderId, updateFields);
        if (updated) {
          sentCount++;
          console.log(`✅ Order ${orderId}: SMS sent and recorded`);
        } else {
          failedCount++;
          console.log(`❌ Order ${orderId}: SMS sent but failed to update Airtable`);
        }
      } else {
        // Send alert email on failure
        failedCount++;
        console.log(`❌ Order ${orderId}: SMS send failed - ${smsResult.error}`);
        
        await sendAlertEmail(
          {
            name: `${first_name || ''} ${last_name || ''}`.trim() || 'N/A',
            phone: phone_number,
            email: email
          },
          smsBody,
          {
            errorCode: smsResult.errorCode || 'UNKNOWN',
            errorMessage: smsResult.error,
            sid: 'N/A'
          },
          {
            orderId: orderId,
            eventDate: event_date,
            airtableRecordId: orderId
          }
        );
      }
    }
    
    console.log(`\n📈 Initial SMS Results: ${sentCount} sent, ${skippedCount} skipped, ${failedCount} failed`);
    return { sent: sentCount, skipped: skippedCount, failed: failedCount };
  } catch (error) {
    console.error('❌ Error in processNewOrders:', error.message);
    return { sent: 0, skipped: 0, failed: 0, error: error.message };
  }
}

/**
 * Process event-day reminders for unconfirmed orders
 * Reminder triggers at 9 AM Pacific time on the day of the Truvay Night Out
 */
async function processEventDayReminders() {
  console.log('\n🔔 Processing event-day reminders...');
  
  try {
    // Find all pending orders where reminder hasn't been sent yet
    const pendingOrders = await getAllRecords(
      CONFIG.airtable.tables.orderInfo,
      `AND({sms_confirmation_status} = 'pending', {sms_confirmation_reminder_sent_date} = BLANK())`
    );
    
    console.log(`Found ${pendingOrders.length} pending orders`);
    
    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    
    for (const order of pendingOrders) {
      const {
        id: orderId,
        event_date,
        link_customer,
        sms_confirmation_link_token,
        first_name,
        last_name,
        email
      } = order;
      
      // Check if event_date is today
      if (!isEventToday(event_date)) {
        console.log(`⏭️  Skipping order ${orderId}: event is not today (event_date: ${event_date})`);
        skippedCount++;
        continue;
      }
      
      // Check if it's 9 AM or later in Pacific timezone
      if (!isAfter9AM_Pacific()) {
        const now = new Date();
        const pacificTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
        const hours = String(pacificTime.getHours()).padStart(2, '0');
        const minutes = String(pacificTime.getMinutes()).padStart(2, '0');
        console.log(`⏭️  Skipping order ${orderId}: not yet 9 AM Pacific (current time: ${hours}:${minutes})`);
        skippedCount++;
        continue;
      }
      
      // Get primary customer
      const primaryCustomerId = Array.isArray(link_customer) ? link_customer[0] : link_customer;
      if (!primaryCustomerId) {
        console.log(`⏭️  Skipping order ${orderId}: no primary customer`);
        skippedCount++;
        continue;
      }
      
      const customer = await getRecord(CONFIG.airtable.tables.customer, primaryCustomerId);
      if (!customer) {
        console.log(`⏭️  Skipping order ${orderId}: customer not found`);
        skippedCount++;
        continue;
      }
      
      const { phone_number } = customer;
      if (!phone_number) {
        console.log(`⏭️  Skipping order ${orderId}: no phone number`);
        skippedCount++;
        continue;
      }
      
      // Get confirmation URL (should already have token)
      const token = sms_confirmation_link_token;
      if (!token) {
        console.log(`⏭️  Skipping order ${orderId}: no confirmation token`);
        skippedCount++;
        continue;
      }
      
      const confirmationUrl = buildConfirmationUrl(token);
      
      // Compose reminder SMS
      const smsBody = getReminderTemplate(confirmationUrl);
      
      console.log(`\n📱 Sending reminder SMS to ${phone_number}...`);
      console.log(`   Event date: ${event_date} (Pacific timezone - 9 AM trigger)`);
      const smsResult = await sendSMS(phone_number, smsBody, true);
      
      if (smsResult.success) {
        // Don't update any fields - just log that reminder was sent
        sentCount++;
        console.log(`✅ Order ${orderId}: Reminder SMS sent`);
      } else {
        failedCount++;
        console.log(`❌ Order ${orderId}: Reminder send failed - ${smsResult.error}`);
        
        await sendAlertEmail(
          {
            name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'N/A',
            phone: phone_number,
            email: customer.email
          },
          smsBody,
          {
            errorCode: smsResult.errorCode || 'UNKNOWN',
            errorMessage: smsResult.error,
            sid: 'N/A'
          },
          {
            orderId: orderId,
            eventDate: event_date,
            airtableRecordId: orderId
          }
        );
      }
    }
    
    console.log(`\n📈 Reminder Results: ${sentCount} sent, ${skippedCount} skipped, ${failedCount} failed`);
    return { sent: sentCount, skipped: skippedCount, failed: failedCount };
  } catch (error) {
    console.error('❌ Error in processEventDayReminders:', error.message);
    return { sent: 0, skipped: 0, failed: 0, error: error.message };
  }
}

// ==================== LAMBDA HANDLER ====================

async function handler(event, context) {
  console.log('\n🚀 Welcome Confirmation Lambda - Start');
  console.log(`Timestamp: ${getCurrentTimeInPacific()}`);
  
  initTwilio();
  
  try {
    // Process initial SMS
    const initialResults = await processNewOrders();
    
    // Process event-day reminders
    const reminderResults = await processEventDayReminders();
    
    // Check if there were any errors during processing
    if (initialResults.error || reminderResults.error) {
      const errorMessage = initialResults.error || reminderResults.error;
      console.error('❌ Processing error detected - sending alert email');
      
      // Send error alert email
      const errorEmailBody = `
Truvay Welcome Confirmation Lambda - ERROR

Timestamp: ${new Date().toISOString()}
Pacific Time: ${getCurrentTimeInPacific()}

Error Details:
Initial SMS Processing: ${initialResults.error || 'Success'}
Reminder Processing: ${reminderResults.error || 'Success'}

Results:
- Initial SMS: Sent=${initialResults.sent || 0}, Skipped=${initialResults.skipped || 0}, Failed=${initialResults.failed || 0}
- Reminders: Sent=${reminderResults.sent || 0}, Skipped=${reminderResults.skipped || 0}, Failed=${reminderResults.failed || 0}

Please investigate and fix the issue immediately.
`;

      const command = new SendEmailCommand({
        FromEmailAddress: CONFIG.alerts.fromEmail,
        Destination: {
          ToAddresses: [CONFIG.alerts.email]
        },
        Content: {
          Simple: {
            Subject: {
              Data: '🚨 Truvay Welcome Confirmation Lambda - ERROR DETECTED'
            },
            Body: {
              Text: {
                Data: errorEmailBody
              }
            }
          }
        }
      });

      try {
        await sesClient.send(command);
        console.log(`📧 Error alert email sent to ${CONFIG.alerts.email}`);
      } catch (emailError) {
        console.error('❌ Failed to send error alert email:', emailError.message);
      }
    }
    
    const response = {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Welcome Confirmation Lambda completed',
        timestamp: new Date().toISOString(),
        results: {
          initialSMS: initialResults,
          reminders: reminderResults
        }
      })
    };
    
    console.log('\n✅ Welcome Confirmation Lambda - Complete');
    return response;
  } catch (error) {
    console.error('❌ Lambda error:', error);
    
    // Send critical error email
    const errorEmailBody = `
Truvay Welcome Confirmation Lambda - CRITICAL ERROR

Timestamp: ${new Date().toISOString()}
Pacific Time: ${getCurrentTimeInPacific()}

Error Details:
${error.message}
${error.stack || ''}

Please investigate and fix immediately.
`;

    const command = new SendEmailCommand({
      FromEmailAddress: CONFIG.alerts.fromEmail,
      Destination: {
        ToAddresses: [CONFIG.alerts.email]
      },
      Content: {
        Simple: {
          Subject: {
            Data: '🚨 Truvay Welcome Confirmation Lambda - CRITICAL ERROR'
          },
          Body: {
            Text: {
              Data: errorEmailBody
            }
          }
        }
      }
    });

    try {
      await sesClient.send(command);
      console.log(`📧 Critical error alert email sent to ${CONFIG.alerts.email}`);
    } catch (emailError) {
      console.error('❌ Failed to send critical error email:', emailError.message);
    }
    
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message,
        timestamp: new Date().toISOString()
      })
    };
  }
}

// ==================== LOCAL EXECUTION ====================
if (require.main === module) {
  handler({}, {}).then(result => {
    console.log('\nHandler result:', result);
  }).catch(error => {
    console.error('Handler error:', error);
  });
}

// ==================== EXPORTS ====================
module.exports = { handler };
