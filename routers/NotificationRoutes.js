import { sendPush } from '../utils/apn.js';
import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { supabase } from '../utils/supabase.js';
import nodemailer from 'nodemailer';

const router = Router();

router.post('/send-invite', async (req, res) => {
  const { to, name, businessName, link, imageUrl } = req.body;

  if (!to || !name || !businessName || !link) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'Gmail',
      auth: {
        user: process.env.GMAIL_USERNAME,
        pass: process.env.GMAIL_PASSWORD,
      },
    });

    const htmlContent = `
      <div style="font-family: sans-serif; padding: 20px;">
        <h2>Hi ${name},</h2>
        <p>You’ve been invited to join <strong>${businessName}</strong> on Movaro!</p>
        <p>Please click the button below to download the app and complete your signup:</p>
        <a href="${link}" style="background-color: #1D4ED8; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Download Movaro</a>
        <br /><br />
        ${imageUrl ? `<img src="${imageUrl}" alt="Movaro" style="margin-top: 20px; max-width: 100%; height: auto;" />` : ''}
        <p style="margin-top: 20px;">If you have any questions, contact your manager or support@movaro.app.</p>
      </div>
    `;

    await transporter.sendMail({
      from: process.env.GMAIL_USERNAME,
      to,
      subject: `You're Invited to Join ${businessName} on Movaro`,
      html: htmlContent,
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error sending invite email:', error);
    res.status(500).json({ error: 'Failed to send email.' });
  }
});

// Trigger push
router.post('/send', async (req, res) => {
  const { token, title, body, sendAt } = req.body;
  if (sendAt) {
    setTimeout(async () => {
      try {
        const result = await sendPush(token, title, body);
        console.log('📤 Scheduled APNs result:', JSON.stringify(result, null, 2));
      } catch (err) {
        console.error('❌ Scheduled push error:', err);
      }
    }, sendAt);

    console.log(`⏳ Notification scheduled in ${sendAt / 60000} seconds`);

    return res.status(200).json({ success: true, scheduled: true, delayInMs: sendAt });
  } else {
    try {
      const result = await sendPush(token, title, body);
      console.log('📤 APNs result:', JSON.stringify(result, null, 2));
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('❌ Push route error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
});

const upload = multer({ storage: multer.memoryStorage() });

router.post('/upload-profile-image', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided.' });
    }

    const fileBuffer = req.file.buffer;
    const originalName = req.file.originalname;
    const uniqueName = `${uuidv4()}_${originalName}`;

    const { data, error } = await supabase.storage
      .from('profile-images')
      .upload(uniqueName, fileBuffer, {
        contentType: req.file.mimetype,
      });

    if (error) {
      console.error('Supabase upload error:', error);
      return res.status(500).json({ error: 'Failed to upload to storage' });
    }

    const publicUrl = `https://bsatjkrkstfwcmvsjzqp.supabase.co/storage/v1/object/public/profile-images/${uniqueName}`;

    return res.status(200).json({ success: true, url: publicUrl });
  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/upload-product-image', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided.' });
    }

    const fileBuffer = req.file.buffer;
    const originalName = req.file.originalname;
    const uniqueName = `${uuidv4()}_${originalName}`;

    const { data, error } = await supabase.storage
      .from('product-images')
      .upload(uniqueName, fileBuffer, {
        contentType: req.file.mimetype,
      });

    if (error) {
      console.error('Supabase upload error:', error);
      return res.status(500).json({ error: 'Failed to upload to storage' });
    }

    const publicUrl = `https://bsatjkrkstfwcmvsjzqp.supabase.co/storage/v1/object/public/product-images/${uniqueName}`;

    return res.status(200).json({ success: true, url: publicUrl });
  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/upload-payment-image', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided.' });
    }

    const fileBuffer = req.file.buffer;
    const originalName = req.file.originalname;
    const uniqueName = `${uuidv4()}_${originalName}`;

    const { data, error } = await supabase.storage
      .from('payment-images')
      .upload(uniqueName, fileBuffer, {
        contentType: req.file.mimetype,
      });

    if (error) {
      console.error('Supabase upload error:', error);
      return res.status(500).json({ error: 'Failed to upload to storage' });
    }

    const publicUrl = `https://bsatjkrkstfwcmvsjzqp.supabase.co/storage/v1/object/public/payment-images/${uniqueName}`;

    return res.status(200).json({ success: true, url: publicUrl });
  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/upload-pickup-admin-image', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided.' });
    }

    const fileBuffer = req.file.buffer;
    const originalName = req.file.originalname;
    const uniqueName = `${uuidv4()}_${originalName}`;

    const { data, error } = await supabase.storage
      .from('pickup-admin-images')
      .upload(uniqueName, fileBuffer, {
        contentType: req.file.mimetype,
      });

    if (error) {
      console.error('Supabase upload error:', error);
      return res.status(500).json({ error: 'Failed to upload to storage' });
    }

    const publicUrl = `https://bsatjkrkstfwcmvsjzqp.supabase.co/storage/v1/object/public/pickup-admin-images/${uniqueName}`;

    return res.status(200).json({ success: true, url: publicUrl });
  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/upload-pickup-image', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided.' });
    }

    const fileBuffer = req.file.buffer;
    const originalName = req.file.originalname;
    const uniqueName = `${uuidv4()}_${originalName}`;

    const { data, error } = await supabase.storage
      .from('pickup-images')
      .upload(uniqueName, fileBuffer, {
        contentType: req.file.mimetype,
      });

    if (error) {
      console.error('Supabase upload error:', error);
      return res.status(500).json({ error: 'Failed to upload to storage' });
    }

    const publicUrl = `https://bsatjkrkstfwcmvsjzqp.supabase.co/storage/v1/object/public/pickup-images/${uniqueName}`;

    return res.status(200).json({ success: true, url: publicUrl });
  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/upload-driver-image', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided.' });
    }

    const fileBuffer = req.file.buffer;
    const originalName = req.file.originalname;
    const uniqueName = `${uuidv4()}_${originalName}`;

    const { data, error } = await supabase.storage
      .from('driver-images')
      .upload(uniqueName, fileBuffer, {
        contentType: req.file.mimetype,
      });

    if (error) {
      console.error('Supabase upload error:', error);
      return res.status(500).json({ error: 'Failed to upload to storage' });
    }

    const publicUrl = `https://bsatjkrkstfwcmvsjzqp.supabase.co/storage/v1/object/public/driver-images/${uniqueName}`;

    return res.status(200).json({ success: true, url: publicUrl });
  } catch (error) {
    console.error('Server error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
