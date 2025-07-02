import { sendPush } from '../utils/apn.js';
import { Router } from 'express';
import { supabase } from '../utils/SupabaseClient.js';

const router = Router();

router.post('/store-device-token', async (req, res) => {
  const { userId, token } = req.body;

  console.log(userId, token);

  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }

  const { error } = await supabase
    .from('Profile') // Replace with your actual table
    .update({ apnToken: token })
    .eq('userId', userId);

  if (error) {
    console.error('❌ Failed to store APNs token:', error.message);
    return res.status(500).json({ error: 'Error storing token' });
  }

  return res.status(200).json({ success: true });
});

// Trigger push
router.post('/send', async (req, res) => {
  const { token, title, body } = req.body;

  try {
    const result = await sendPush(token, title, body);
    console.log('📤 APNs result:', JSON.stringify(result, null, 2));

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ Push route error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
