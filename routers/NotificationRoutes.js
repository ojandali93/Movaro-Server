import { sendPush } from '../utils/apn.js';
import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { supabase } from '../utils/supabase.js';

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

export default router;
