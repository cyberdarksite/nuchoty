require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const HEROKU_API_KEY = process.env.HEROKU_API_KEY || '';
const HEROKU_TEAM = process.env.HEROKU_TEAM || 'iamricky';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/heroku-deployer';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || '';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// MongoDB Connection
mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log('✅ Connected to MongoDB');
}).catch(err => {
    console.error('❌ MongoDB connection error:', err);
});

// MongoDB Schemas
const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    walletBalance: { type: Number, default: 0 },
    totalDeposits: { type: Number, default: 0 },
    totalSpent: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    transactions: [{
        type: { type: String, enum: ['deposit', 'deployment'], required: true },
        amount: { type: Number, required: true },
        reference: { type: String },
        description: { type: String },
        date: { type: Date, default: Date.now },
        status: { type: String, enum: ['pending', 'success', 'failed'], default: 'success' }
    }],
    deployments: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Deployment'
    }]
});

const paymentSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    email: { type: String, required: true },
    amount: { type: Number, required: true },
    reference: { type: String, unique: true, required: true },
    type: { type: String, enum: ['deposit', 'deployment'], default: 'deposit' },
    status: { 
        type: String, 
        enum: ['pending', 'success', 'failed', 'expired'],
        default: 'pending'
    },
    paymentDate: { type: Date, default: Date.now },
    metadata: { type: Object, default: {} }
});

const deploymentSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    email: { type: String, required: true },
    appName: { type: String, required: true },
    repoUrl: { type: String, required: true },
    sessionId: { type: String, required: true },
    teamName: { type: String, default: 'iamricky' },
    paymentReference: { type: String },
    amountPaid: { type: Number, default: 0 },
    deploymentStatus: {
        type: String,
        enum: ['pending', 'building', 'deployed', 'failed'],
        default: 'pending'
    },
    appUrl: { type: String },
    buildId: { type: String },
    createdAt: { type: Date, default: Date.now },
    deployedAt: { type: Date },
    errorMessage: { type: String }
});

const User = mongoose.model('User', userSchema);
const Payment = mongoose.model('Payment', paymentSchema);
const Deployment = mongoose.model('Deployment', deploymentSchema);

// Heroku API configuration
const herokuHeaders = {
    'Authorization': `Bearer ${HEROKU_API_KEY}`,
    'Accept': 'application/vnd.heroku+json; version=3',
    'Content-Type': 'application/json'
};

// Paystack API configuration
const paystackHeaders = {
    'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json'
};

// ==================== PAYSTACK ROUTES ====================

// 1. Initialize deposit (fund wallet)
app.post('/api/deposit/initialize', async (req, res) => {
    try {
        const { email, amount, userId } = req.body;

        if (!email || !amount || !userId) {
            return res.status(400).json({
                success: false,
                error: 'Email, amount, and userId are required'
            });
        }

        if (amount < 100) {
            return res.status(400).json({
                success: false,
                error: 'Minimum deposit is 100 NGN'
            });
        }

        // Generate unique reference
        const reference = `DEPOSIT-${Date.now()}-${uuidv4().slice(0, 8)}`;

        // Initialize payment with Paystack
        const response = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: email,
                amount: amount * 100, // Paystack uses kobo (multiply by 100)
                reference: reference,
                callback_url: `${APP_URL}/api/payment/verify/${reference}`,
                metadata: {
                    userId: userId,
                    type: 'deposit',
                    email: email,
                    amount: amount
                }
            },
            { headers: paystackHeaders }
        );

        if (response.data.status) {
            // Save payment record
            const payment = new Payment({
                userId: userId,
                email: email,
                amount: amount,
                reference: reference,
                type: 'deposit',
                status: 'pending',
                metadata: {
                    authorization_url: response.data.data.authorization_url,
                    access_code: response.data.data.access_code
                }
            });
            await payment.save();

            return res.json({
                success: true,
                authorization_url: response.data.data.authorization_url,
                reference: reference,
                message: 'Payment initialized successfully'
            });
        } else {
            return res.status(400).json({
                success: false,
                error: response.data.message || 'Payment initialization failed'
            });
        }

    } catch (error) {
        console.error('Deposit error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to initialize deposit',
            details: error.response?.data || error.message
        });
    }
});

// 2. Verify payment (webhook & callback)
app.get('/api/payment/verify/:reference', async (req, res) => {
    try {
        const { reference } = req.params;

        // Verify with Paystack
        const response = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            { headers: paystackHeaders }
        );

        if (response.data.status && response.data.data.status === 'success') {
            const paymentData = response.data.data;
            const metadata = paymentData.metadata || {};

            // Update payment record
            const payment = await Payment.findOneAndUpdate(
                { reference: reference },
                { 
                    status: 'success',
                    paymentDate: new Date(),
                    metadata: { ...paymentData, ...metadata }
                },
                { new: true }
            );

            if (payment) {
                // If deposit, update user wallet
                if (payment.type === 'deposit') {
                    const user = await User.findOneAndUpdate(
                        { email: payment.email },
                        { 
                            $inc: { 
                                walletBalance: payment.amount,
                                totalDeposits: payment.amount
                            },
                            $push: {
                                transactions: {
                                    type: 'deposit',
                                    amount: payment.amount,
                                    reference: reference,
                                    description: `Deposit of ₦${payment.amount}`,
                                    status: 'success'
                                }
                            }
                        },
                        { upsert: true, new: true }
                    );

                    return res.redirect(`${APP_URL}/wallet?status=success&amount=${payment.amount}`);
                }
            }

            return res.redirect(`${APP_URL}/wallet?status=success`);
        } else {
            // Payment failed
            await Payment.findOneAndUpdate(
                { reference: reference },
                { status: 'failed' }
            );

            return res.redirect(`${APP_URL}/wallet?status=failed`);
        }

    } catch (error) {
        console.error('Verify error:', error.response?.data || error.message);
        res.redirect(`${APP_URL}/wallet?status=error`);
    }
});

// 3. Paystack Webhook (for real-time payment verification)
app.post('/api/payment/webhook', async (req, res) => {
    try {
        // Verify webhook signature
        const signature = req.headers['x-paystack-signature'];
        const hash = crypto
            .createHmac('sha512', PAYSTACK_SECRET_KEY)
            .update(JSON.stringify(req.body))
            .digest('hex');

        if (hash !== signature) {
            return res.status(401).send('Invalid signature');
        }

        const event = req.body;
        const data = event.data;

        if (event.event === 'charge.success') {
            const reference = data.reference;
            const paymentData = data.metadata || {};

            // Update payment record
            const payment = await Payment.findOneAndUpdate(
                { reference: reference },
                { 
                    status: 'success',
                    paymentDate: new Date(),
                    metadata: data
                },
                { new: true }
            );

            if (payment && payment.type === 'deposit') {
                // Update user wallet
                await User.findOneAndUpdate(
                    { email: payment.email },
                    { 
                        $inc: { 
                            walletBalance: payment.amount,
                            totalDeposits: payment.amount
                        },
                        $push: {
                            transactions: {
                                type: 'deposit',
                                amount: payment.amount,
                                reference: reference,
                                description: `Deposit of ₦${payment.amount}`,
                                status: 'success'
                            }
                        }
                    },
                    { upsert: true }
                );

                // Also trigger deployment if this was a deployment payment
                if (payment.type === 'deployment') {
                    await processDeployment(payment);
                }
            }

            return res.status(200).json({ success: true });
        }

        res.status(200).json({ success: true });

    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// ==================== DEPLOYMENT ROUTES ====================

// Process deployment after payment
async function processDeployment(payment) {
    try {
        const metadata = payment.metadata;
        const { appName, repoUrl, sessionId, teamName, userId, email } = metadata;

        // Check if user has enough balance
        const user = await User.findOne({ email: email });
        if (user.walletBalance < payment.amount) {
            throw new Error('Insufficient balance');
        }

        // Deduct from wallet
        await User.findOneAndUpdate(
            { email: email },
            {
                $inc: { 
                    walletBalance: -payment.amount,
                    totalSpent: payment.amount
                },
                $push: {
                    transactions: {
                        type: 'deployment',
                        amount: payment.amount,
                        reference: payment.reference,
                        description: `Deployment of ${appName}`,
                        status: 'success'
                    }
                }
            }
        );

        // Deploy the app
        const generatedAppName = appName?.trim()
            ? appName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
            : `app-${uuidv4().slice(0, 8)}`;

        const targetTeam = teamName || HEROKU_TEAM || 'iamricky';

        // Create Heroku app
        const createAppRes = await axios.post(
            'https://api.heroku.com/organizations/apps',
            {
                name: generatedAppName,
                organization: targetTeam
            },
            { headers: herokuHeaders }
        );

        // Set config vars
        await axios.patch(
            `https://api.heroku.com/apps/${generatedAppName}/config-vars`,
            { 
                SESSION_ID: sessionId,
                TEAM_NAME: targetTeam,
                DEPLOYED_BY: email,
                DEPLOYMENT_DATE: new Date().toISOString()
            },
            { headers: herokuHeaders }
        );

        // Trigger build from GitHub
        const buildRes = await axios.post(
            `https://api.heroku.com/apps/${generatedAppName}/builds`,
            {
                source_blob: {
                    url: repoUrl
                }
            },
            { headers: herokuHeaders }
        );

        // Save deployment record
        const deployment = new Deployment({
            userId: userId,
            email: email,
            appName: generatedAppName,
            repoUrl: repoUrl,
            sessionId: sessionId,
            teamName: targetTeam,
            paymentReference: payment.reference,
            amountPaid: payment.amount,
            deploymentStatus: 'building',
            appUrl: createAppRes.data.web_url || `https://${generatedAppName}.herokuapp.com`,
            buildId: buildRes.data.id
        });
        await deployment.save();

        // Link deployment to user
        await User.findOneAndUpdate(
            { email: email },
            { $push: { deployments: deployment._id } }
        );

        console.log(`✅ Deployment successful: ${generatedAppName}`);
        return deployment;

    } catch (error) {
        console.error('Deployment processing error:', error);
        throw error;
    }
}

// 4. Deploy app using wallet balance
app.post('/api/deploy', async (req, res) => {
    try {
        const { email, appName, repoUrl, sessionId, teamName, amount } = req.body;

        // Validate required fields
        if (!email || !appName || !repoUrl || !sessionId) {
            return res.status(400).json({
                success: false,
                error: 'Email, appName, repoUrl, and sessionId are required'
            });
        }

        // Check if user exists and has balance
        const user = await User.findOne({ email: email });
        if (!user) {
            return res.status(400).json({
                success: false,
                error: 'User not found. Please deposit funds first.'
            });
        }

        const deploymentCost = amount || 500; // Default cost per deployment

        if (user.walletBalance < deploymentCost) {
            return res.status(400).json({
                success: false,
                error: 'Insufficient balance',
                balance: user.walletBalance,
                required: deploymentCost,
                message: 'Please deposit funds to continue'
            });
        }

        // Generate payment reference
        const reference = `DEPLOY-${Date.now()}-${uuidv4().slice(0, 8)}`;

        // Create payment record
        const payment = new Payment({
            userId: user._id.toString(),
            email: email,
            amount: deploymentCost,
            reference: reference,
            type: 'deployment',
            status: 'success',
            metadata: {
                appName: appName,
                repoUrl: repoUrl,
                sessionId: sessionId,
                teamName: teamName,
                userId: user._id.toString(),
                email: email
            }
        });
        await payment.save();

        // Process deployment
        const deployment = await processDeployment(payment);

        res.json({
            success: true,
            message: 'Deployment started successfully!',
            appName: deployment.appName,
            appUrl: deployment.appUrl,
            buildId: deployment.buildId,
            dashboardUrl: `https://dashboard.heroku.com/teams/${deployment.teamName}/apps/${deployment.appName}`,
            balanceRemaining: user.walletBalance - deploymentCost,
            deploymentCost: deploymentCost
        });

    } catch (error) {
        console.error('Deployment error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: 'Deployment failed',
            details: error.response?.data || error.message
        });
    }
});

// 5. Get user wallet balance
app.get('/api/wallet/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const user = await User.findOne({ email: email });

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        res.json({
            success: true,
            email: user.email,
            walletBalance: user.walletBalance,
            totalDeposits: user.totalDeposits,
            totalSpent: user.totalSpent,
            transactions: user.transactions.slice(-10), // Last 10 transactions
            deploymentCount: user.deployments.length
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to fetch wallet',
            details: error.message
        });
    }
});

// 6. Get user deployment history
app.get('/api/deployments/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const deployments = await Deployment.find({ email: email })
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            count: deployments.length,
            deployments: deployments
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to fetch deployments',
            details: error.message
        });
    }
});

// 7. Get transaction history
app.get('/api/transactions/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const user = await User.findOne({ email: email });

        if (!user) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            });
        }

        res.json({
            success: true,
            transactions: user.transactions.sort((a, b) => b.date - a.date)
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to fetch transactions',
            details: error.message
        });
    }
});

// 8. Team info endpoint
app.get('/api/team-info', async (req, res) => {
    try {
        const teamName = req.query.team || HEROKU_TEAM || 'iamricky';
        
        const appsRes = await axios.get(
            `https://api.heroku.com/teams/${teamName}/apps`,
            { headers: herokuHeaders }
        );

        res.json({
            success: true,
            team: teamName,
            appCount: appsRes.data.length,
            apps: appsRes.data.map(app => ({
                name: app.name,
                url: app.web_url || `https://${app.name}.herokuapp.com`,
                createdAt: app.created_at,
                updatedAt: app.updated_at
            }))
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to fetch team info',
            details: error.response?.data || error.message
        });
    }
});

// 9. Check build status
app.get('/api/build-status/:appName/:buildId', async (req, res) => {
    try {
        const { appName, buildId } = req.params;
        
        const buildRes = await axios.get(
            `https://api.heroku.com/apps/${appName}/builds/${buildId}`,
            { headers: herokuHeaders }
        );

        res.json({
            success: true,
            appName: appName,
            buildId: buildId,
            status: buildRes.data.status,
            createdAt: buildRes.data.created_at,
            updatedAt: buildRes.data.updated_at
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to fetch build status',
            details: error.response?.data || error.message
        });
    }
});

// 10. Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        service: 'Heroku Deployer with Paystack',
        version: '3.0.0',
        team: HEROKU_TEAM || 'iamricky',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        mongodb: mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected',
        paystack: PAYSTACK_SECRET_KEY ? 'Configured' : 'Not Configured'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route not found',
        path: req.path
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: 'Internal server error',
        details: err.message
    });
});

// Start the server
app.listen(PORT, () => {
    console.log(`🚀 Heroku Deployer with Paystack running on port ${PORT}`);
    console.log(`📁 Default team: ${HEROKU_TEAM || 'iamricky'}`);
    console.log(`💰 Paystack: ${PAYSTACK_SECRET_KEY ? '✅ Configured' : '❌ Not Configured'}`);
    console.log(`📊 MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '❌ Disconnected'}`);
    console.log(`🌐 App URL: ${APP_URL}`);
});