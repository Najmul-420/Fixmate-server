import { MongoClient, ObjectId } from 'mongodb';
import express from 'express';
import 'dotenv/config';
import cors from 'cors';
import Stripe from 'stripe';

const PORT = process.env.PORT || 5000;
const app = express();

// ─── CORS ────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: 'http://localhost:3000',
    credentials: true,
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-user-email',
      'x-user-role',
    ],
  })
);

// ─── RAW BODY for Stripe webhook ─────────────────────────────────────────────
// Must be registered BEFORE express.json()
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));

// ─── JSON body parser ─────────────────────────────────────────────────────────
app.use(express.json());

// ─── MongoDB ─────────────────────────────────────────────────────────────────

const client = new MongoClient(process.env.MONGODB_URI ,{
  // Server selection timeout: fail fast after 5 seconds instead of hanging
  serverSelectionTimeoutMS: 10000,
 
});

let db, usersCollection, servicesCollection, bookingsCollection, paymentsCollection;

async function run() {
  try {
    await client.connect();
    db = client.db('fixmate');
    usersCollection = db.collection('user');
    servicesCollection = db.collection('service');
    bookingsCollection = db.collection('bookings');
    paymentsCollection = db.collection('payments');
    console.log('Connected to MongoDB — fixmate database ready.');
  } catch (err) {
    console.error('MongoDB connection error:', err);
    // Provide specific guidance based on error type
    if (err.name === 'MongoNetworkError') {
      console.error('\n--- MongoDB Network Error ---');
      console.error('This may indicate:');
      console.error('1. MongoDB Atlas cluster is stopped or paused');
      console.error('2. IP whitelist does not include this server\'s IP');
      console.error('3. Network/firewall blocking outbound connections to MongoDB Atlas');
      console.error('4. DNS resolution issues with .mongodb.net domain');
      console.error('---');
      console.error('Please verify:');
      console.error('- MongoDB Atlas cluster status (should be RUNNING, not PAUSED)');
      console.error('- IP Access List in MongoDB Atlas Dashboard');
      console.error('- Network connectivity on port 27017');
    }
    process.exit(1);
  }
}
await run();

// ─── Stripe ──────────────────────────────────────────────────────────────────
let stripe = null;
if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.includes('REPLACE')) {
  stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function isValidObjectId(id) {
  return ObjectId.isValid(id) && String(new ObjectId(id)) === id;
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

/**
 * extractUser — reads x-user-email and x-user-role custom headers.
 * Does NOT reject the request; routes can decide if they need these.
 */
function extractUser(req, res, next) {
  req.userEmail = req.headers['x-user-email'] || null;
  req.userRole = req.headers['x-user-role'] || null;
  next();
}

/** Require a specific role; must be used after extractUser */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.userRole || !roles.includes(req.userRole)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Required role: ${roles.join(' or ')}.`,
      });
    }
    next();
  };
}

// Apply extractUser globally so all routes can read the headers
app.use(extractUser);

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ success: true, message: 'FixMate Server is Running!' });
});

// ══════════════════════════════════════════════════════════════════════════════
//  SERVICES
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/services — public
app.get('/api/services', async (req, res) => {
  try {
    const {
      status = 'approved',
      category,
      serviceMode,
      sort,
      limit,
      technicianEmail,
      search,
    } = req.query;

    const query = {};

    if (status) query.approvalStatus = status;
    if (category) query.category = category;
    if (serviceMode) query.serviceMode = serviceMode;
    if (technicianEmail) query.technicianEmail = technicianEmail;

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } },
      ];
    }

    let sortOption = { createdAt: -1 }; // default: newest
    if (sort === 'price_asc') sortOption = { basePrice: 1 };
    else if (sort === 'price_desc') sortOption = { basePrice: -1 };
    else if (sort === 'newest') sortOption = { createdAt: -1 };

    let cursor = servicesCollection.find(query).sort(sortOption);
    if (limit) cursor = cursor.limit(parseInt(limit));

    const services = await cursor.toArray();
    res.json({ success: true, services });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/services/section-wise — public
// Returns services grouped by category/section for responsive card layouts
app.get('/api/services/section-wise', async (req, res) => {
  try {
    // Fetch all approved and available services
    const query = { approvalStatus: 'approved' };
    const services = await servicesCollection.find(query).toArray();

    // Group services by category
    const sections = {};

    services.forEach((service) => {
      const category = service.category || 'Other';
      if (!sections[category]) {
        sections[category] = [];
      }
      sections[category].push(service);
    });

    // Sort services within each section by createdAt (newest first)
    Object.keys(sections).forEach((category) => {
      sections[category].sort((a, b) => {
        const aDate = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bDate = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bDate - aDate;
      });
    });

    res.json({ success: true, sections });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/services/:id — public
app.get('/api/services/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid service ID.' });
    }

    const service = await servicesCollection.findOne({ _id: new ObjectId(id) });
    if (!service) {
      return res.status(404).json({ success: false, message: 'Service not found.' });
    }

    // Join technician info from user collection
    let technician = null;
    if (service.technicianEmail) {
      technician = await usersCollection.findOne(
        { email: service.technicianEmail },
        { projection: { password: 0 } }
      );
    }

    res.json({ success: true, data: { ...service, technician } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/services — technician only
app.post('/api/services', requireRole('technician'), async (req, res) => {
  try {
    const {
      title,
      category,
      description,
      image,
      basePrice,
      estimatedDuration,
      serviceMode,
      serviceArea,
    } = req.body;

    if (!title || !category || !basePrice) {
      return res
        .status(400)
        .json({ success: false, message: 'title, category, and basePrice are required.' });
    }

    // Fetch technician's name from user collection
    const techUser = await usersCollection.findOne({ email: req.userEmail });
    const technicianName = techUser ? techUser.name || techUser.email : req.userEmail;

    const service = {
      title,
      category,
      description: description || '',
      image: image || '',
      basePrice: parseFloat(basePrice),
      estimatedDuration: estimatedDuration || '',
      serviceMode: serviceMode || 'in-person',
      serviceArea: serviceArea || '',
      technicianName,
      technicianEmail: req.userEmail,
      approvalStatus: 'pending',
      isAvailable: true,
      createdAt: new Date(),
    };

    const result = await servicesCollection.insertOne(service);
    res.status(201).json({ success: true, data: { ...service, _id: result.insertedId } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PATCH /api/services/:id — technician (own) or admin
app.patch('/api/services/:id', requireRole('technician', 'admin'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid service ID.' });
    }

    const service = await servicesCollection.findOne({ _id: new ObjectId(id) });
    if (!service) {
      return res.status(404).json({ success: false, message: 'Service not found.' });
    }

    // Technician can only update their own service
    if (req.userRole === 'technician' && service.technicianEmail !== req.userEmail) {
      return res.status(403).json({ success: false, message: 'You can only update your own services.' });
    }

    const allowedFields = [
      'title', 'category', 'description', 'image',
      'basePrice', 'estimatedDuration', 'serviceMode', 'serviceArea', 'isAvailable',
    ];
    // Admin-only fields
    const adminOnlyFields = ['approvalStatus'];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (req.userRole === 'admin') {
      for (const field of adminOnlyFields) {
        if (req.body[field] !== undefined) updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid fields to update.' });
    }

    updates.updatedAt = new Date();

    const result = await servicesCollection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: updates },
      { returnDocument: 'after' }
    );

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /api/services/:id — technician (own only), rejected if active bookings
app.delete('/api/services/:id', requireRole('technician'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid service ID.' });
    }

    const service = await servicesCollection.findOne({ _id: new ObjectId(id) });
    if (!service) {
      return res.status(404).json({ success: false, message: 'Service not found.' });
    }

    if (service.technicianEmail !== req.userEmail) {
      return res.status(403).json({ success: false, message: 'You can only delete your own services.' });
    }

    // Check for active bookings
    const activeBooking = await bookingsCollection.findOne({
      serviceId: id,
      status: { $in: ['requested', 'accepted', 'in-progress'] },
    });
    if (activeBooking) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete service with active bookings.',
      });
    }

    await servicesCollection.deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true, message: 'Service deleted successfully.' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  BOOKINGS
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/bookings — no server auth required
app.get('/api/bookings', async (req, res) => {
  try {
    const { customerEmail, technicianEmail } = req.query;
    const query = {};
    if (customerEmail) query.customerEmail = customerEmail;
    if (technicianEmail) query.technicianEmail = technicianEmail;

    const bookings = await bookingsCollection
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, bookings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/bookings — customer only
app.post('/api/bookings', requireRole('customer'), async (req, res) => {
  try {
    const { serviceId, customerPhone, address, preferredDate, problemDescription } = req.body;

    if (!serviceId) {
      return res.status(400).json({ success: false, message: 'serviceId is required.' });
    }

    // Validate serviceId format
    if (!isValidObjectId(serviceId)) {
      return res.status(400).json({ success: false, message: 'Invalid serviceId.' });
    }

    // Fetch service
    const service = await servicesCollection.findOne({ _id: new ObjectId(serviceId) });
    if (!service) {
      return res.status(404).json({ success: false, message: 'Service not found.' });
    }

    // Service must be approved and available
    if (service.approvalStatus !== 'approved' || !service.isAvailable) {
      return res.status(400).json({
        success: false,
        message: 'Service is not available for booking.',
      });
    }

    const customerEmail = req.userEmail;

    // Customer cannot book their own service
    if (service.technicianEmail === customerEmail) {
      return res.status(400).json({
        success: false,
        message: 'You cannot book your own service.',
      });
    }

    // No duplicate active booking
    const duplicate = await bookingsCollection.findOne({
      serviceId,
      customerEmail,
      status: { $in: ['requested', 'accepted', 'in-progress'] },
    });
    if (duplicate) {
      return res.status(400).json({
        success: false,
        message: 'You already have an active booking for this service.',
      });
    }

    // Fetch customer info
    const customerUser = await usersCollection.findOne({ email: customerEmail });
    const customerName = customerUser ? customerUser.name || customerEmail : customerEmail;

    const booking = {
      serviceId,
      serviceTitle: service.title,
      serviceImage: service.image || '',
      category: service.category,
      basePrice: service.basePrice,
      technicianName: service.technicianName,
      technicianEmail: service.technicianEmail,
      customerName,
      customerEmail,
      customerPhone: customerPhone || '',
      address: address || '',
      preferredDate: preferredDate || '',
      problemDescription: problemDescription || '',
      status: 'requested',
      paymentStatus: 'unpaid',
      finalAmount: null,
      createdAt: new Date(),
    };

    const result = await bookingsCollection.insertOne(booking);
    res.status(201).json({ success: true, data: { ...booking, _id: result.insertedId } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PATCH /api/bookings/:id — status transitions
app.patch('/api/bookings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid booking ID.' });
    }

    const booking = await bookingsCollection.findOne({ _id: new ObjectId(id) });
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found.' });
    }

    const { status, finalAmount } = req.body;
    const role = req.userRole;
    const currentStatus = booking.status;
    const updates = {};

    if (role === 'customer') {
      // Customer can only cancel a 'requested' booking
      if (status !== 'cancelled') {
        return res.status(400).json({ success: false, message: 'Customers can only cancel bookings.' });
      }
      if (currentStatus !== 'requested') {
        return res.status(400).json({
          success: false,
          message: `Cannot cancel a booking with status '${currentStatus}'.`,
        });
      }
      // Verify this is the customer's booking
      if (booking.customerEmail !== req.userEmail) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }
      updates.status = 'cancelled';
    } else if (role === 'technician') {
      // Verify this is the technician's booking
      if (booking.technicianEmail !== req.userEmail) {
        return res.status(403).json({ success: false, message: 'Access denied.' });
      }

      const validTransitions = {
        requested: ['accepted', 'rejected'],
        accepted: ['in-progress'],
        'in-progress': ['completed'],
      };

      if (!validTransitions[currentStatus] || !validTransitions[currentStatus].includes(status)) {
        return res.status(400).json({
          success: false,
          message: `Invalid transition from '${currentStatus}' to '${status}'.`,
        });
      }

      updates.status = status;

      if (status === 'completed') {
        if (!finalAmount || parseFloat(finalAmount) <= 0) {
          return res.status(400).json({
            success: false,
            message: 'finalAmount is required and must be > 0 when marking as completed.',
          });
        }
        updates.finalAmount = parseFloat(finalAmount);
      }
    } else if (role === 'admin') {
      // Admin can set any status directly
      if (status) updates.status = status;
      if (finalAmount) updates.finalAmount = parseFloat(finalAmount);
    } else {
      return res.status(403).json({ success: false, message: 'Access denied.' });
    }

    updates.updatedAt = new Date();

    const result = await bookingsCollection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: updates },
      { returnDocument: 'after' }
    );

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  PAYMENTS
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/payments/stats — admin overview (must be before /api/payments/:id)
app.get('/api/payments/stats', async (req, res) => {
  try {
    const stats = await paymentsCollection
      .aggregate([
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: '$amount' },
            totalTransactions: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const result = stats[0] || { totalRevenue: 0, totalTransactions: 0 };
    res.json({
      success: true,
      data: {
        totalRevenue: result.totalRevenue,
        totalTransactions: result.totalTransactions,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/payments — supports customerEmail and technicianEmail query params
app.get('/api/payments', async (req, res) => {
  try {
    const { customerEmail, technicianEmail } = req.query;
    const query = {};
    if (customerEmail) query.customerEmail = customerEmail;
    if (technicianEmail) query.technicianEmail = technicianEmail;

    const payments = await paymentsCollection
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ success: true, payments });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/payments/create-checkout-session
app.post('/api/payments/create-checkout-session', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ success: false, message: 'Payment system not configured.' });
    }

    const { bookingId } = req.body;
    if (!bookingId) {
      return res.status(400).json({ success: false, message: 'bookingId is required.' });
    }
    if (!isValidObjectId(bookingId)) {
      return res.status(400).json({ success: false, message: 'Invalid bookingId.' });
    }

    const booking = await bookingsCollection.findOne({ _id: new ObjectId(bookingId) });
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found.' });
    }
    if (booking.status !== 'completed') {
      return res.status(400).json({ success: false, message: 'Booking must be completed before payment.' });
    }
    if (booking.paymentStatus !== 'unpaid') {
      return res.status(400).json({ success: false, message: 'Booking is already paid.' });
    }
    if (!booking.finalAmount || booking.finalAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid final amount for this booking.' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: booking.serviceTitle || 'FixMate Service',
              description: `Booking for ${booking.serviceTitle} — ${booking.technicianName}`,
            },
            unit_amount: Math.round(booking.finalAmount * 100), // Stripe expects cents
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      metadata: {
        bookingId: bookingId,
        customerEmail: booking.customerEmail || '',
        technicianEmail: booking.technicianEmail || '',
      },
      success_url: `http://localhost:3000/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `http://localhost:3000/payment/cancel`,
    });

    res.json({ success: true, url: session.url });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/payments/webhook — Stripe webhook (raw body)
app.post('/api/payments/webhook', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ success: false, message: 'Payment system not configured.' });
    }

    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    if (webhookSecret) {
      try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
      } catch (err) {
        return res.status(400).json({ success: false, message: `Webhook Error: ${err.message}` });
      }
    } else {
      // No webhook secret configured — parse raw body manually
      event = JSON.parse(req.body.toString());
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const bookingId = session.metadata?.bookingId;

      if (bookingId && isValidObjectId(bookingId)) {
        // Update booking paymentStatus to 'paid'
        const booking = await bookingsCollection.findOneAndUpdate(
          { _id: new ObjectId(bookingId) },
          { $set: { paymentStatus: 'paid', updatedAt: new Date() } },
          { returnDocument: 'after' }
        );

        // Create payment record
        if (booking) {
          await paymentsCollection.insertOne({
            bookingId,
            stripeSessionId: session.id,
            stripePaymentIntentId: session.payment_intent || null,
            amount: (session.amount_total || 0) / 100, // convert cents to dollars
            currency: session.currency || 'usd',
            customerEmail: session.metadata?.customerEmail || booking.customerEmail,
            technicianEmail: session.metadata?.technicianEmail || booking.technicianEmail,
            serviceTitle: booking.serviceTitle || '',
            status: 'succeeded',
            createdAt: new Date(),
          });
        }
      }
    }

    res.json({ received: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  USERS
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/users — returns all users (admin use)
app.get('/api/users', async (req, res) => {
  try {
    const users = await usersCollection
      .find({}, { projection: { password: 0 } })
      .toArray();
    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/users/:email — returns single user by email
app.get('/api/users/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const user = await usersCollection.findOne(
      { email },
      { projection: { password: 0 } }
    );
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }
    res.json({ success: true, data: user });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PATCH /api/users/:id — allows updating role (admin), phone, area, bio
app.patch('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Support both ObjectId and email as the identifier
    let query;
    if (isValidObjectId(id)) {
      query = { _id: new ObjectId(id) };
    } else {
      // Treat as email
      query = { email: id };
    }

    const user = await usersCollection.findOne(query, { projection: { password: 0 } });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const allowedFields = ['phone', 'area', 'bio'];
    const adminOnlyFields = ['role'];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (req.userRole === 'admin') {
      for (const field of adminOnlyFields) {
        if (req.body[field] !== undefined) updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid fields to update.' });
    }

    updates.updatedAt = new Date();

    const result = await usersCollection.findOneAndUpdate(
      query,
      { $set: updates },
      { returnDocument: 'after', projection: { password: 0 } }
    );

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─── 404 fallback ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found.' });
});

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: err.message || 'Internal Server Error' });
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`FixMate server is running on port ${PORT}`);
});
