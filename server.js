const express = require('express');
const session = require('express-session');
const pg = require('pg');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');

app.set('trust proxy', 1);

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5
});

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new PgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS registrations (
      id BIGSERIAL PRIMARY KEY,
      application_id TEXT UNIQUE NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      other_name TEXT,
      date_of_birth TEXT NOT NULL,
      gender TEXT NOT NULL,
      class_applying TEXT NOT NULL,
      guardian_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      relationship TEXT NOT NULL,
      address TEXT NOT NULL,
      previous_school TEXT,
      previous_class TEXT,
      additional_info TEXT,
      payment_reference TEXT UNIQUE,
      payment_amount INTEGER,
      payment_currency TEXT,
      paid_at TIMESTAMPTZ,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pending_registrations (
      id BIGSERIAL PRIMARY KEY,
      payment_reference TEXT UNIQUE NOT NULL,
      registration_data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Safe migrations for databases created by an older version of the site.
  await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS payment_reference TEXT UNIQUE`);
  await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS payment_amount INTEGER`);
  await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS payment_currency TEXT`);
  await pool.query(`ALTER TABLE registrations ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`);
}

function makePaymentReference() {
  return `DAFS_${Date.now()}_${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

function makeApplicationId() {
  const d = new Date();
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0')
  ].join('');
  return `DAFS-${stamp}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function clean(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function validateRegistration(b) {
  const required = [
    'firstName', 'lastName', 'dateOfBirth', 'gender',
    'classApplying', 'guardianName', 'phone', 'email',
    'relationship', 'address'
  ];

  return required.every(k => clean(b[k]));
}

function getBaseUrl(req) {
  return PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

async function paystackRequest(endpoint, options = {}) {
  if (!PAYSTACK_SECRET_KEY) {
    throw new Error('PAYSTACK_SECRET_KEY is not configured on the server.');
  }

  const response = await fetch(`https://api.paystack.co${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  let body = {};
  try {
    body = await response.json();
  } catch (_) {}

  if (!response.ok || !body.status) {
    const error = body?.message || 'Paystack request failed.';
    const err = new Error(error);
    err.status = response.status;
    throw err;
  }

  return body;
}

async function verifyPaystackPayment(reference) {
  const result = await paystackRequest(
    `/transaction/verify/${encodeURIComponent(reference)}`
  );

  const tx = result.data;

  if (
    !tx ||
    tx.status !== 'success' ||
    Number(tx.amount) !== 100000 ||
    tx.currency !== 'NGN' ||
    tx.reference !== reference
  ) {
    return {
      success: false,
      message: 'Payment was not verified as a successful ₦1,000 payment.'
    };
  }

  return {
    success: true,
    reference: tx.reference,
    amount: Number(tx.amount),
    currency: tx.currency,
    paidAt: tx.paid_at || tx.paidAt || null,
    customerEmail: tx.customer?.email || null
  };
}

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, paymentProvider: 'Paystack' });
  } catch (e) {
    console.error(e);
    res.status(503).json({ ok: false });
  }
});

/*
 * PAYMENT-FIRST FLOW
 *
 * 1. Browser sends the completed form here.
 * 2. We store it only in pending_registrations.
 * 3. We initialize a ₦1,000 Paystack transaction.
 * 4. Browser is sent to Paystack checkout.
 * 5. The callback page calls /api/paystack/complete/:reference.
 * 6. The server verifies directly with Paystack.
 * 7. ONLY after verification do we insert into registrations.
 */
app.post('/api/paystack/initialize', async (req, res) => {
  const b = req.body || {};

  if (!validateRegistration(b)) {
    return res.status(400).json({
      message: 'Please complete all required fields, including an email address.'
    });
  }

  if (!PAYSTACK_SECRET_KEY) {
    return res.status(500).json({
      message: 'Paystack is not configured yet. Add PAYSTACK_SECRET_KEY to the server environment.'
    });
  }

  const paymentReference = makePaymentReference();
  const registrationData = {
    firstName: clean(b.firstName),
    lastName: clean(b.lastName),
    otherName: clean(b.otherName),
    dateOfBirth: clean(b.dateOfBirth),
    gender: clean(b.gender),
    classApplying: clean(b.classApplying),
    guardianName: clean(b.guardianName),
    phone: clean(b.phone),
    email: clean(b.email),
    relationship: clean(b.relationship),
    address: clean(b.address),
    previousSchool: clean(b.previousSchool),
    previousClass: clean(b.previousClass),
    additionalInfo: clean(b.additionalInfo)
  };

  try {
    await pool.query(
      `INSERT INTO pending_registrations (payment_reference, registration_data)
       VALUES ($1, $2::jsonb)`,
      [paymentReference, JSON.stringify(registrationData)]
    );

    const callbackUrl = `${getBaseUrl(req)}/payment-callback.html`;

    const result = await paystackRequest('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email: registrationData.email,
        amount: 100000,
        currency: 'NGN',
        reference: paymentReference,
        callback_url: callbackUrl,
        metadata: {
          payment_for: 'DAFS Registration Form',
          application_type: 'student_registration',
          registration_reference: paymentReference
        }
      })
    });

    res.json({
      reference: paymentReference,
      authorizationUrl: result.data.authorization_url
    });
  } catch (e) {
    console.error('Paystack initialize error:', e);
    await pool.query(
      `DELETE FROM pending_registrations WHERE payment_reference = $1`,
      [paymentReference]
    ).catch(() => {});

    res.status(500).json({
      message: e.message || 'Could not start Paystack payment.'
    });
  }
});

app.get('/api/paystack/complete/:reference', async (req, res) => {
  const reference = clean(req.params.reference);

  if (!reference) {
    return res.status(400).json({
      success: false,
      message: 'Payment reference is missing.'
    });
  }

  try {
    const pendingResult = await pool.query(
      `SELECT registration_data FROM pending_registrations
       WHERE payment_reference = $1`,
      [reference]
    );

    if (!pendingResult.rows.length) {
      // It may already have been completed. Return the existing application.
      const existing = await pool.query(
        `SELECT application_id AS "applicationId"
         FROM registrations WHERE payment_reference = $1`,
        [reference]
      );

      if (existing.rows.length) {
        return res.json({
          success: true,
          alreadyCompleted: true,
          applicationId: existing.rows[0].applicationId
        });
      }

      return res.status(404).json({
        success: false,
        message: 'Pending registration not found.'
      });
    }

    const payment = await verifyPaystackPayment(reference);

    if (!payment.success) {
      return res.status(402).json({
        success: false,
        message: payment.message
      });
    }

    const data = pendingResult.rows[0].registration_data;
    const applicationId = makeApplicationId();

    await pool.query('BEGIN');
    try {
      await pool.query(`
        INSERT INTO registrations
        (application_id,first_name,last_name,other_name,date_of_birth,gender,
         class_applying,guardian_name,phone,email,relationship,address,
         previous_school,previous_class,additional_info,
         payment_reference,payment_amount,payment_currency,paid_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      `, [
        applicationId,
        data.firstName,
        data.lastName,
        data.otherName,
        data.dateOfBirth,
        data.gender,
        data.classApplying,
        data.guardianName,
        data.phone,
        data.email,
        data.relationship,
        data.address,
        data.previousSchool,
        data.previousClass,
        data.additionalInfo,
        payment.reference,
        payment.amount,
        payment.currency,
        payment.paidAt ? new Date(payment.paidAt) : new Date()
      ]);

      await pool.query(
        `DELETE FROM pending_registrations WHERE payment_reference = $1`,
        [reference]
      );

      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }

    res.json({
      success: true,
      applicationId,
      paymentReference: payment.reference
    });
  } catch (e) {
    console.error('Paystack completion error:', e);

    if (e.code === '23505') {
      const existing = await pool.query(
        `SELECT application_id AS "applicationId"
         FROM registrations WHERE payment_reference = $1`,
        [reference]
      ).catch(() => ({ rows: [] }));

      if (existing.rows.length) {
        return res.json({
          success: true,
          alreadyCompleted: true,
          applicationId: existing.rows[0].applicationId
        });
      }
    }

    res.status(500).json({
      success: false,
      message: 'Payment was successful but the registration could not be finalized yet. Please contact the school with your payment reference.'
    });
  }
});

app.post('/api/register', async (req, res) => {
  // Kept as a compatibility endpoint, but it cannot create a registration.
  // This prevents anyone from bypassing the payment-first flow.
  return res.status(402).json({
    message: 'Payment is required before registration can be submitted.'
  });
});

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(401).json({ message: 'Unauthorized' });
}

app.post('/api/admin/login', (req, res) => {
  const username = clean(req.body?.username);
  const password = clean(req.body?.password);

  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({
      message: 'Invalid username or password.'
    });
  }

  req.session.admin = { username };

  req.session.save(err => {
    if (err) {
      console.error('Session save error:', err);
      return res.status(500).json({
        message: 'Could not create login session.'
      });
    }

    return res.json({ username });
  });
});

app.get('/api/admin/me', (req, res) => {
  if (!req.session || !req.session.admin) {
    return res.status(401).json({ message: 'Not signed in' });
  }
  res.json(req.session.admin);
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ message: 'Could not log out.' });
    }

    res.clearCookie('connect.sid', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax'
    });

    res.json({ ok: true });
  });
});

app.get('/api/registrations', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        application_id AS "applicationId",
        first_name AS "firstName",
        last_name AS "lastName",
        other_name AS "otherName",
        date_of_birth AS "dateOfBirth",
        gender,
        class_applying AS "classApplying",
        guardian_name AS "guardianName",
        phone,
        email,
        relationship,
        address,
        previous_school AS "previousSchool",
        previous_class AS "previousClass",
        additional_info AS "additionalInfo",
        payment_reference AS "paymentReference",
        payment_amount AS "paymentAmount",
        payment_currency AS "paymentCurrency",
        paid_at AS "paidAt",
        submitted_at AS "submittedAt"
      FROM registrations
      ORDER BY submitted_at ASC
    `);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({
      message: 'Could not load registrations.'
    });
  }
});

app.use(express.static(__dirname));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`DAFS running on ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Database initialization failed:', err);
    process.exit(1);
  });
