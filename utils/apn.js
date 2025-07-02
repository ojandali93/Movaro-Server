import apn from 'apn';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

const keyFilePath = path.join(os.tmpdir(), 'apns_key.p8');

// Write the key file only once (Render's temp dir resets on each deploy)
if (!fs.existsSync(keyFilePath)) {
  const keyBuffer = Buffer.from(process.env.APN_PRIVATE_KEY_B64, 'base64');
  fs.writeFileSync(keyFilePath, keyBuffer);
}

const apnProvider = new apn.Provider({
  token: {
    key: keyFilePath, // ✅ Now this is a valid path
    keyId: process.env.APN_KEY_ID,
    teamId: process.env.APN_TEAM_ID
  },
  production: true // or false if you're testing
});

export const sendPush = async (deviceToken, title, body) => {
  const notification = new apn.Notification();
  notification.alert = { title, body };
  notification.sound = 'default';
  notification.topic = process.env.APN_BUNDLE_ID;

  try {
    const result = await apnProvider.send(notification, deviceToken);
    return result;
  } catch (err) {
    console.error('❌ Error sending push:', err);
    return { sent: [], failed: [{ device: deviceToken, error: err }] };
  }
};