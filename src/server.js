/*
 ╔══════════════════════════════════════════════════════════════╗
 ║   TALAT MAZHAR SPIRITUAL SCIENCES — BACKEND API              ║
 ║   Deploy to: Render.com (Free tier works)                    ║
 ║   Stack: Express · Supabase · Anthropic · Stripe · JWT       ║
 ╚══════════════════════════════════════════════════════════════╝

 ENVIRONMENT VARIABLES (set in Render dashboard):
 ─────────────────────────────────────────────────
 ANTHROPIC_API_KEY      → Your Anthropic key (sk-ant-...)
 SUPABASE_URL           → https://xxxx.supabase.co
 SUPABASE_SERVICE_KEY   → Your Supabase service_role key
 STRIPE_SECRET_KEY      → sk_live_... or sk_test_...
 STRIPE_WEBHOOK_SECRET  → whsec_... (from Stripe dashboard)
 JWT_SECRET             → Any long random string
 ADMIN_PASSWORD         → Your admin panel password
 FRONTEND_URL           → https://your-site.com (for CORS)
 WA_NUMBER              → 923000000000 (your WhatsApp)

 SUPABASE TABLES (run this SQL in Supabase SQL editor):
 ─────────────────────────────────────────────────────
 See /sql/schema.sql comments at bottom of this file.
*/

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const { v4: uuid } = require('uuid');
const Anthropic  = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const Stripe     = require('stripe');

const app  = express();
const PORT = process.env.PORT || 3001;

/* ─── CLIENTS ─────────────────────────────────── */
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase  = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_placeholder');

/* ─── MIDDLEWARE ──────────────────────────────── */
app.use(helmet({
  contentSecurityPolicy: false, // Frontend handles this
  crossOriginEmbedderPolicy: false,
}));
app.use(morgan('combined'));
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || '*',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    'http://localhost:5500',
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token'],
  credentials: true,
}));

// Stripe webhook needs raw body — register before express.json()
app.use('/api/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));

/* ─── RATE LIMITERS ───────────────────────────── */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 100,
  message: { error: 'Too many requests. Please try again later.' },
});
const chatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30, // 30 AI messages per IP per hour
  message: { error: 'Chat limit reached. Please try again in an hour.' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many auth attempts.' },
});
app.use('/api/', apiLimiter);

/* ─── AUTH MIDDLEWARE ─────────────────────────── */
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET || 'fallback-secret-change-me');
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'Admin token required' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret-change-me');
    if (decoded.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid admin token' });
  }
}

/* ─── HEALTH CHECK ────────────────────────────── */
app.get('/', (req, res) => {
  res.json({
    service: 'Talat Mazhar Spiritual Sciences API',
    version: '1.0.0',
    status: 'online',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

/* ══════════════════════════════════════════════
   NOOR AI CHAT  /api/chat
══════════════════════════════════════════════ */
app.post('/api/chat', chatLimiter, async (req, res) => {
  const { message, history = [], system } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  // Fetch live courses from Supabase to inject into system prompt
  let coursesText = '';
  try {
    const { data: courses } = await supabase
      .from('courses')
      .select('title,category,price,original_price,duration,sessions,description,includes_vcall')
      .eq('status', 'active')
      .order('created_at', { ascending: true });

    if (courses?.length) {
      coursesText = courses.map(c =>
        `- ${c.title} | ${c.category} | PKR ${c.price.toLocaleString()}` +
        (c.original_price ? ` (was PKR ${c.original_price.toLocaleString()})` : '') +
        ` | ${c.duration || ''} ${c.sessions || ''}` +
        (c.includes_vcall ? ' | Includes 1v1 WhatsApp video call' : '') +
        ` | ${c.description}`
      ).join('\n');
    }
  } catch (e) {
    console.error('Supabase courses fetch error:', e.message);
  }

  const defaultSystem = `You are Noor — the AI spiritual companion and guide for Talat Mazhar Spiritual Sciences.

PERSONA: Deeply wise, warm, poetic. You speak like a trusted spiritual elder — not a chatbot. You draw naturally from Rumi, Ibn Arabi, the Quran, Hadith, and the wisdom traditions of the East and West. You are simultaneously a spiritual guide, course consultant, sales advisor, and compassionate companion.

YOUR ROLES:
1. SPIRITUAL COMPANION — Engage deeply with questions about Sufism, fana/baqa, dhikr, the nafs, Quran, eschatology, comparative religion, vibration & frequency, dream interpretation, yoga, healing. Give real, thoughtful answers — never surface level.
2. COURSE ADVISOR — Recommend the right course based on the seeker's questions and spiritual stage.
3. SALES MANAGER — Know all prices, packages, what's included. Guide toward enrollment naturally and warmly. Never pushy.
4. 1v1 SESSION GUIDE — Private WhatsApp video sessions with Talat Sahib: 30min PKR 3,500 | 60min PKR 6,000 | 90min PKR 8,500. Payment confirmed via WhatsApp, then session is scheduled.

${coursesText ? `LIVE COURSES:\n${coursesText}` : 'Courses are being updated.'}

PAYMENT: We accept JazzCash, EasyPaisa, bank transfer, and credit/debit cards via Stripe. All confirmed via WhatsApp.

LANGUAGE: Respond in the same language the student uses (Urdu or English). If Urdu, write in proper Urdu script.

STYLE: Full, unhurried answers. Use occasional Arabic phrases naturally (bismillah, alhamdulillah). Share wisdom generously. Recommend enrollment only when the student's need is clear. This is sacred work — every response matters.`;

  try {
    const messages = [
      ...(history || []).slice(-14).map(m => ({
        role: m.role,
        content: m.content,
      })),
      { role: 'user', content: message },
    ];

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      system: system || defaultSystem,
      messages,
    });

    const reply = response.content[0]?.text || 'I am momentarily unavailable. Please try again.';

    // Log conversation to Supabase (optional analytics)
    try {
      await supabase.from('chat_logs').insert({
        session_id: req.ip,
        user_message: message,
        noor_reply: reply,
        created_at: new Date().toISOString(),
      });
    } catch (_) {} // Non-blocking

    res.json({ reply, model: 'claude-sonnet-4-20250514' });
  } catch (err) {
    console.error('Anthropic error:', err.message);
    res.status(500).json({ reply: 'I am having a brief connection issue. Please try again in a moment.', error: err.message });
  }
});

/* ══════════════════════════════════════════════
   COURSES API
══════════════════════════════════════════════ */

// GET all public active courses
app.get('/api/courses', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('courses')
      .select('*')
      .eq('status', 'active')
      .order('sort_order', { ascending: true });
    if (error) throw error;
    res.json({ courses: data || [] });
  } catch (err) {
    console.error('Courses fetch error:', err.message);
    res.status(500).json({ error: 'Could not fetch courses' });
  }
});

// GET single course
app.get('/api/courses/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('courses')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error || !data) return res.status(404).json({ error: 'Course not found' });
    res.json({ course: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET course videos (only for enrolled students)
app.get('/api/courses/:id/videos', requireAuth, async (req, res) => {
  try {
    // Check enrollment
    const { data: enrollment } = await supabase
      .from('enrollments')
      .select('status')
      .eq('student_id', req.user.id)
      .eq('course_id', req.params.id)
      .single();

    if (!enrollment || enrollment.status !== 'active') {
      return res.status(403).json({ error: 'Not enrolled in this course' });
    }

    const { data: videos, error } = await supabase
      .from('course_videos')
      .select('id, title, title_urdu, duration, order_index, is_preview, thumbnail_url, video_url, description')
      .eq('course_id', req.params.id)
      .order('order_index', { ascending: true });

    if (error) throw error;
    res.json({ videos: videos || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN: Create course
app.post('/api/admin/courses', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('courses')
      .insert([{
        ...req.body,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }])
      .select()
      .single();
    if (error) throw error;
    res.json({ course: data, message: 'Course created successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN: Update course
app.put('/api/admin/courses/:id', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('courses')
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw error;
    res.json({ course: data, message: 'Course updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN: Delete course
app.delete('/api/admin/courses/:id', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('courses').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ message: 'Course deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN: Add video to course
app.post('/api/admin/courses/:id/videos', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('course_videos')
      .insert([{ ...req.body, course_id: req.params.id }])
      .select()
      .single();
    if (error) throw error;
    res.json({ video: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════
   STUDENT AUTH
══════════════════════════════════════════════ */

// Register (called after admin approves enrollment)
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { name, email, password, phone, language = 'en' } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });

  try {
    // Check if already exists
    const { data: existing } = await supabase
      .from('students')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 12);
    const { data, error } = await supabase
      .from('students')
      .insert([{
        id: uuid(),
        name,
        email: email.toLowerCase(),
        password_hash: hashed,
        phone: phone || '',
        language,
        created_at: new Date().toISOString(),
      }])
      .select('id, name, email, phone, language')
      .single();
    if (error) throw error;

    const token = jwt.sign(
      { id: data.id, email: data.email, name: data.name, role: 'student' },
      process.env.JWT_SECRET || 'fallback-secret-change-me',
      { expiresIn: '30d' }
    );

    res.json({ student: data, token });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const { data: student } = await supabase
      .from('students')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();

    if (!student) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, student.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // Get enrollments
    const { data: enrollments } = await supabase
      .from('enrollments')
      .select('*, courses(id, title, category, thumbnail_url, includes_vcall)')
      .eq('student_id', student.id);

    const token = jwt.sign(
      { id: student.id, email: student.email, name: student.name, role: 'student' },
      process.env.JWT_SECRET || 'fallback-secret-change-me',
      { expiresIn: '30d' }
    );

    res.json({
      token,
      student: {
        id: student.id,
        name: student.name,
        email: student.email,
        phone: student.phone,
        language: student.language,
      },
      enrollments: enrollments || [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get my profile + enrollments
app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const { data: student } = await supabase
      .from('students')
      .select('id, name, email, phone, language, created_at')
      .eq('id', req.user.id)
      .single();

    const { data: enrollments } = await supabase
      .from('enrollments')
      .select('*, courses(*)')
      .eq('student_id', req.user.id);

    res.json({ student, enrollments: enrollments || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════
   ENROLLMENT
══════════════════════════════════════════════ */

// Submit enrollment request (WhatsApp payment flow)
app.post('/api/enroll', async (req, res) => {
  const { course_id, name, email, phone, language = 'en', payment_method = 'whatsapp' } = req.body;
  if (!course_id || !name || !phone) return res.status(400).json({ error: 'Course, name and phone required' });

  try {
    // Get course
    const { data: course } = await supabase
      .from('courses')
      .select('id, title, price')
      .eq('id', course_id)
      .single();
    if (!course) return res.status(404).json({ error: 'Course not found' });

    // Create or get student record
    let studentId = uuid();
    if (email) {
      const { data: existing } = await supabase
        .from('students')
        .select('id')
        .eq('email', email.toLowerCase())
        .single();
      if (existing) {
        studentId = existing.id;
      } else {
        await supabase.from('students').insert([{
          id: studentId, name, email: email.toLowerCase(),
          phone, language, created_at: new Date().toISOString(),
        }]);
      }
    }

    // Create pending enrollment
    const { data: enrollment, error } = await supabase
      .from('enrollments')
      .insert([{
        id: uuid(),
        student_id: studentId,
        course_id,
        student_name: name,
        student_email: email || '',
        student_phone: phone,
        amount: course.price,
        payment_method,
        status: 'pending',
        language,
        created_at: new Date().toISOString(),
      }])
      .select()
      .single();
    if (error) throw error;

    res.json({
      enrollment,
      message: 'Enrollment request received. Please complete payment via WhatsApp.',
      whatsapp_url: `https://wa.me/${process.env.WA_NUMBER || '923000000000'}?text=${encodeURIComponent(
        `Assalam o Alaikum,\n\nI would like to enroll in:\n*${course.title}*\nPrice: PKR ${course.price.toLocaleString()}\n\nName: ${name}\nPhone: ${phone}${email ? `\nEmail: ${email}` : ''}\n\nEnrollment ID: ${enrollment.id}`
      )}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════
   STRIPE PAYMENTS
══════════════════════════════════════════════ */

// Create Stripe checkout session
app.post('/api/payment/stripe/checkout', async (req, res) => {
  const { course_id, name, email, phone, success_url, cancel_url } = req.body;
  if (!course_id || !email) return res.status(400).json({ error: 'Course ID and email required' });

  try {
    const { data: course } = await supabase
      .from('courses')
      .select('id, title, price, thumbnail_url')
      .eq('id', course_id)
      .single();
    if (!course) return res.status(404).json({ error: 'Course not found' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'pkr',
          product_data: {
            name: course.title,
            description: `Talat Mazhar Spiritual Sciences — ${course.title}`,
            images: course.thumbnail_url ? [course.thumbnail_url] : [],
          },
          unit_amount: course.price * 100, // Stripe uses paisa
        },
        quantity: 1,
      }],
      metadata: {
        course_id: course.id.toString(),
        student_name: name || '',
        student_email: email,
        student_phone: phone || '',
      },
      success_url: success_url || `${process.env.FRONTEND_URL}?payment=success&course=${course.id}`,
      cancel_url: cancel_url || `${process.env.FRONTEND_URL}?payment=cancelled`,
    });

    // Create pending enrollment
    await supabase.from('enrollments').insert([{
      id: uuid(),
      course_id,
      student_name: name || '',
      student_email: email,
      student_phone: phone || '',
      amount: course.price,
      payment_method: 'stripe',
      stripe_session_id: session.id,
      status: 'pending',
      created_at: new Date().toISOString(),
    }]);

    res.json({ url: session.url, session_id: session.id });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Stripe webhook — auto-approve on successful payment
app.post('/api/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      // Activate enrollment
      await supabase
        .from('enrollments')
        .update({ status: 'active', paid_at: new Date().toISOString() })
        .eq('stripe_session_id', session.id);

      console.log(`✓ Payment completed for session ${session.id}`);
    } catch (err) {
      console.error('Enrollment activation error:', err.message);
    }
  }

  res.json({ received: true });
});

/* ══════════════════════════════════════════════
   1V1 VIDEO CALL BOOKING
══════════════════════════════════════════════ */

// Book a session
app.post('/api/vcall/book', async (req, res) => {
  const { name, phone, email, package: pkg, preferred_time, language = 'en', notes } = req.body;
  if (!name || !phone || !pkg) return res.status(400).json({ error: 'Name, phone and package required' });

  const packages = {
    v1: { name: '30-Minute Session', price: 3500 },
    v2: { name: '60-Minute Session', price: 6000 },
    v3: { name: '90-Minute Session', price: 8500 },
  };
  const selected = packages[pkg];
  if (!selected) return res.status(400).json({ error: 'Invalid package' });

  try {
    const { data, error } = await supabase
      .from('vcall_bookings')
      .insert([{
        id: uuid(),
        name, phone, email: email || '',
        package: pkg,
        package_name: selected.name,
        amount: selected.price,
        preferred_time: preferred_time || '',
        notes: notes || '',
        language,
        status: 'pending',
        created_at: new Date().toISOString(),
      }])
      .select()
      .single();
    if (error) throw error;

    const waMsg = `Assalam o Alaikum,\n\nI would like to book a private session with Talat Sahib:\n\n📞 *${selected.name}*\nPrice: PKR ${selected.price.toLocaleString()}\nPreferred Time: ${preferred_time || 'Flexible'}\n\nName: ${name}\nPhone: ${phone}${email ? `\nEmail: ${email}` : ''}${notes ? `\nNotes: ${notes}` : ''}\n\nBooking ID: ${data.id}`;

    res.json({
      booking: data,
      whatsapp_url: `https://wa.me/${process.env.WA_NUMBER || '923000000000'}?text=${encodeURIComponent(waMsg)}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════
   ADMIN ROUTES
══════════════════════════════════════════════ */

// Admin login — returns admin JWT
app.post('/api/admin/login', authLimiter, (req, res) => {
  const { password } = req.body;
  const adminPass = process.env.ADMIN_PASSWORD || 'talatmazhar2026';
  if (password !== adminPass) return res.status(401).json({ error: 'Invalid password' });

  const token = jwt.sign(
    { role: 'admin', id: 'admin', timestamp: Date.now() },
    process.env.JWT_SECRET || 'fallback-secret-change-me',
    { expiresIn: '12h' }
  );

  res.json({ token, message: 'Admin authenticated' });
});

// GET all students with enrollments
app.get('/api/admin/students', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('enrollments')
      .select('*, courses(title)')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ students: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve enrollment
app.put('/api/admin/enrollments/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { data: enrollment } = await supabase
      .from('enrollments')
      .select('*, courses(title)')
      .eq('id', req.params.id)
      .single();
    if (!enrollment) return res.status(404).json({ error: 'Enrollment not found' });

    await supabase
      .from('enrollments')
      .update({ status: 'active', approved_at: new Date().toISOString(), approved_by: 'admin' })
      .eq('id', req.params.id);

    const waMsg = `Assalam o Alaikum ${enrollment.student_name},\n\nAlhamdulillah, your enrollment in *${enrollment.courses?.title}* has been approved! 🌙\n\nPlease login to your student portal to access your course materials.\n\nJazakAllah Khair.`;

    res.json({
      message: 'Enrollment approved',
      whatsapp_notify: `https://wa.me/${enrollment.student_phone?.replace(/\D/g, '')}?text=${encodeURIComponent(waMsg)}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reject enrollment
app.put('/api/admin/enrollments/:id/reject', requireAdmin, async (req, res) => {
  try {
    await supabase.from('enrollments').update({ status: 'rejected' }).eq('id', req.params.id);
    res.json({ message: 'Enrollment rejected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET all vcall bookings
app.get('/api/admin/vcall-bookings', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('vcall_bookings')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ bookings: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET revenue dashboard
app.get('/api/admin/revenue', requireAdmin, async (req, res) => {
  try {
    const { data: enrollments } = await supabase
      .from('enrollments')
      .select('amount, course_id, status, courses(title)')
      .eq('status', 'active');

    const { data: vcalls } = await supabase
      .from('vcall_bookings')
      .select('amount, status')
      .eq('status', 'confirmed');

    const totalCourse = (enrollments || []).reduce((a, e) => a + (e.amount || 0), 0);
    const totalVcall  = (vcalls || []).reduce((a, v) => a + (v.amount || 0), 0);

    // Revenue per course
    const perCourse = {};
    (enrollments || []).forEach(e => {
      const title = e.courses?.title || 'Unknown';
      perCourse[title] = (perCourse[title] || 0) + (e.amount || 0);
    });

    res.json({
      total: totalCourse + totalVcall,
      course_revenue: totalCourse,
      vcall_revenue: totalVcall,
      active_students: (enrollments || []).length,
      per_course: perCourse,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create student account manually
app.post('/api/admin/students/create', requireAdmin, async (req, res) => {
  const { name, email, phone, password, course_id, language = 'en' } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password required' });
  try {
    const hashed = await bcrypt.hash(password, 12);
    const studentId = uuid();
    await supabase.from('students').insert([{
      id: studentId, name, email: email.toLowerCase(),
      password_hash: hashed, phone: phone || '', language,
      created_at: new Date().toISOString(),
    }]);
    if (course_id) {
      const { data: course } = await supabase.from('courses').select('price').eq('id', course_id).single();
      await supabase.from('enrollments').insert([{
        id: uuid(), student_id: studentId, course_id,
        student_name: name, student_email: email, student_phone: phone || '',
        amount: course?.price || 0, payment_method: 'manual', status: 'active',
        created_at: new Date().toISOString(),
      }]);
    }
    res.json({ message: 'Student created and enrolled', student_id: studentId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send WhatsApp broadcast info
app.post('/api/admin/broadcast', requireAdmin, async (req, res) => {
  const { message, target = 'all' } = req.body;
  try {
    let query = supabase.from('enrollments').select('student_name, student_phone');
    if (target === 'active') query = query.eq('status', 'active');
    const { data } = await query;

    const unique = [...new Map((data || []).map(s => [s.student_phone, s])).values()];
    const whatsappLinks = unique
      .filter(s => s.student_phone)
      .map(s => `https://wa.me/${s.student_phone.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`);

    res.json({
      message: 'Broadcast ready',
      recipient_count: whatsappLinks.length,
      links: whatsappLinks.slice(0, 50), // First 50
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════
   PROGRESS TRACKING
══════════════════════════════════════════════ */

// Mark lesson complete
app.post('/api/progress/complete', requireAuth, async (req, res) => {
  const { video_id, course_id } = req.body;
  try {
    await supabase.from('progress').upsert({
      student_id: req.user.id,
      video_id,
      course_id,
      completed_at: new Date().toISOString(),
    }, { onConflict: 'student_id,video_id' });
    res.json({ message: 'Progress saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get my progress for a course
app.get('/api/progress/:course_id', requireAuth, async (req, res) => {
  try {
    const { data } = await supabase
      .from('progress')
      .select('video_id, completed_at')
      .eq('student_id', req.user.id)
      .eq('course_id', req.params.course_id);
    res.json({ completed_videos: (data || []).map(p => p.video_id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════
   START SERVER
══════════════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║  Talat Mazhar API — Running on port ${PORT}    ║
║  Status: ONLINE ✓                          ║
╚════════════════════════════════════════════╝
  `);
});

/* ══════════════════════════════════════════════
   SUPABASE SQL SCHEMA
   Run this in Supabase → SQL Editor → New Query
══════════════════════════════════════════════

-- COURSES
create table courses (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  title_urdu text,
  category text not null,
  price integer not null,
  original_price integer,
  duration text,
  sessions text,
  description text,
  description_urdu text,
  badge text default '',
  status text default 'active',
  includes_vcall boolean default false,
  image_url text,
  thumbnail_url text,
  sort_order integer default 0,
  includes jsonb default '[]',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- COURSE VIDEOS
create table course_videos (
  id uuid primary key default gen_random_uuid(),
  course_id uuid references courses(id) on delete cascade,
  title text not null,
  title_urdu text,
  description text,
  video_url text not null,
  thumbnail_url text,
  duration text,
  order_index integer default 0,
  is_preview boolean default false,
  created_at timestamptz default now()
);

-- STUDENTS
create table students (
  id uuid primary key,
  name text not null,
  email text unique,
  password_hash text,
  phone text,
  language text default 'en',
  created_at timestamptz default now()
);

-- ENROLLMENTS
create table enrollments (
  id uuid primary key,
  student_id uuid,
  course_id uuid references courses(id),
  student_name text,
  student_email text,
  student_phone text,
  amount integer,
  payment_method text default 'whatsapp',
  stripe_session_id text,
  status text default 'pending',
  language text default 'en',
  approved_at timestamptz,
  approved_by text,
  paid_at timestamptz,
  created_at timestamptz default now()
);

-- VCALL BOOKINGS
create table vcall_bookings (
  id uuid primary key,
  name text not null,
  phone text not null,
  email text,
  package text not null,
  package_name text,
  amount integer,
  preferred_time text,
  notes text,
  language text default 'en',
  status text default 'pending',
  zoom_link text,
  created_at timestamptz default now()
);

-- PROGRESS
create table progress (
  student_id uuid,
  video_id uuid,
  course_id uuid,
  completed_at timestamptz default now(),
  primary key (student_id, video_id)
);

-- CHAT LOGS (optional analytics)
create table chat_logs (
  id uuid primary key default gen_random_uuid(),
  session_id text,
  user_message text,
  noor_reply text,
  created_at timestamptz default now()
);

-- RLS (Row Level Security) — Enable for production
alter table students enable row level security;
alter table enrollments enable row level security;
alter table progress enable row level security;

-- Policies (students can only see their own data)
create policy "Students see own data" on students for select using (auth.uid()::text = id::text);
create policy "Students see own enrollments" on enrollments for select using (student_email = auth.jwt()->>'email');
create policy "Students track own progress" on progress for all using (auth.uid()::text = student_id::text);

-- Courses are public
create policy "Courses are public" on courses for select using (true);
create policy "Videos need enrollment" on course_videos for select using (true);
*/
