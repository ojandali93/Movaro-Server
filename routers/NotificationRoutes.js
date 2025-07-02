import { sendPush } from '../utils/APN.js';
import { Router } from 'express';

const router = Router();

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
