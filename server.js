import dotenv from 'dotenv';
import express from 'express';
import axios from 'axios';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== ENVIRONMENT VARIABLES ====================
const HEROKU_API_KEY = process.env.HEROKU_API_KEY || '';
const HEROKU_TEAM = process.env.HEROKU_TEAM || 'iamricky';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/cyberdark-host';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || '';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const DEPLOYMENT_COST = parseInt(process.env.DEPLOYMENT_COST) || 50;
const JWT_SECRET = process.env.JWT_SECRET || 'cyberdark-secret-key-2024';

// ==================== MIDDLEWARE ====================
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== MONGODB CONNECTION ====================
mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(async () => {
    console.log('✅ Connected to MongoDB');
    
    // ====== CREATE ADMIN WITH BALANCE (RUNS ONCE) ======
    await createAdminWithBalance();
    
}).catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
});

// ==================== DATABASE SCHEMAS ====================

// User Schema
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    passwordHash: { type: String, required: true },
    fullName: { type: String },
    walletBalance: { type: Number, default: 0 },
    totalDeposits: { type: Number, default: 0 },
    totalSpent: { type: Number, default: 0 },
    refCode: { type: String, unique: true },
    referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    emailVerified: { type: Boolean, default: false },
    isBanned: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    transactions: [{
        type: { type: String, enum: ['deposit', 'deployment', 'referral'], required: true },
        amount: { type: Number, required: true },
        reference: { type: String },
        description: { type: String },
        date: { type: Date, default: Date.now },
        status: { type: String, enum: ['pending', 'success', 'failed'], default: 'success' }
    }],
    deployments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Deployment' }]
});

// Payment Schema
const paymentSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    email: { type: String, required: true, lowercase: true },
    amount: { type: Number, required: true },
    reference: { type: String, unique: true, required: true },
    type: { type: String, enum: ['deposit', 'deployment'], default: 'deposit' },
    status: { type: String, enum: ['pending', 'success', 'failed', 'expired'], default: 'pending' },
    paymentDate: { type: Date, default: Date.now },
    metadata: { type: Object, default: {} }
});

// Deployment Schema
const deploymentSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    email: { type: String, required: true, lowercase: true },
    appName: { type: String, required: true },
    repoUrl: { type: String, required: true },
    sessionId: { type: String, required: true },
    teamName: { type: String, default: 'iamricky' },
    paymentReference: { type: String },
    amountPaid: { type: Number, default: DEPLOYMENT_COST },
    deploymentStatus: { type: String, enum: ['pending', 'building', 'deployed', 'failed'], default: 'pending' },
    appUrl: { type: String },
    buildId: { type: String },
    logs: [{
        timestamp: { type: Date, default: Date.now },
        message: { type: String },
        type: { type: String, enum: ['info', 'success', 'error', 'warning'], default: 'info' }
    }],
    createdAt: { type: Date, default: Date.now },
    deployedAt: { type: Date },
    errorMessage: { type: String }
});

const User = mongoose.model('User', userSchema);
const Payment = mongoose.model('Payment', paymentSchema);
const Deployment = mongoose.model('Deployment', deploymentSchema);

// ==================== ADMIN SETUP (RUNS ONCE) ====================
const createAdminWithBalance = async () => {
    try {
        const adminEmail = 'admin@yourdomain.com'; // CHANGE THIS
        const adminBalance = 1000;
        const adminPassword = 'admin123456'; // CHANGE THIS

        // Check if admin already exists
        let admin = await User.findOne({ email: adminEmail.toLowerCase() });

        if (!admin) {
            // Create admin with balance
            admin = new User({
                username: 'admin',
                email: adminEmail.toLowerCase(),
                passwordHash: await bcrypt.hash(adminPassword, 12),
                fullName: 'Admin',
                walletBalance: adminBalance,
                refCode: generateRefCode(),
                emailVerified: true,
                transactions: [{
                    type: 'deposit',
                    amount: adminBalance,
                    reference: 'ADMIN-INITIAL-BALANCE',
                    description: 'Admin initial balance setup',
                    status: 'success',
                    date: new Date()
                }]
            });
            await admin.save();
            console.log(`✅ Admin created with ${adminBalance} coins | Email: ${adminEmail} | Password: ${adminPassword}`);
        } else {
            // Admin already exists — check if balance is less than 1000
            if (admin.walletBalance < 1000) {
                admin.walletBalance = 1000;
                admin.transactions.push({
                    type: 'deposit',
                    amount: 1000,
                    reference: 'ADMIN-BALANCE-TOPUP',
                    description: 'Admin balance set to 1000 coins',
                    status: 'success',
                    date: new Date()
                });
                await admin.save();
                console.log(`✅ Admin balance updated to 1000 coins`);
            } else {
                console.log(`✅ Admin already has ${admin.walletBalance} coins — no changes made`);
            }
        }
    } catch (err) {
        console.error('❌ Admin setup error:', err.message);
    }
};

// ==================== HEROKU API ====================
const herokuHeaders = {
    'Authorization': `Bearer ${HEROKU_API_KEY}`,
    'Accept': 'application/vnd.heroku+json; version=3',
    'Content-Type': 'application/json'
};

// ==================== PAYSTACK API ====================
const paystackHeaders = {
    'Authorization': `Bearer ${PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json'
};

// ==================== HELPER FUNCTIONS ====================

const generateRefCode = () => {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
};

const generateToken = (user) => {
    return jwt.sign(
        { userId: user._id, email: user.email },
        JWT_SECRET,
        { expiresIn: '30d' }
    );
};

async function findOrCreateUser(email, username = null) {
    const normalizedEmail = email.toLowerCase();
    let user = await User.findOne({ email: normalizedEmail });
    
    if (!user) {
        user = new User({
            username: username || normalizedEmail.split('@')[0],
            email: normalizedEmail,
            passwordHash: await bcrypt.hash('temp_password_' + Date.now(), 10),
            fullName: username || normalizedEmail.split('@')[0],
            walletBalance: 0,
            refCode: generateRefCode()
        });
        await user.save();
        console.log(`✅ Auto-created user: ${normalizedEmail}`);
    }
    
    return user;
}

async function addDeploymentLog(deploymentId, message, type = 'info') {
    try {
        await Deployment.findByIdAndUpdate(deploymentId, {
            $push: { logs: { timestamp: new Date(), message, type } }
        });
    } catch (error) {
        console.error('Failed to add deployment log:', error.message);
    }
}

// ==================== AUTH ROUTES ====================

// Register
app.post('/api/register', async (req, res) => {
    try {
        const { username, email, password, ref } = req.body;
        
        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Username, email and password required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const normalizedEmail = email.toLowerCase();
        
        // Check if user exists
        const existingUser = await User.findOne({ 
            $or: [{ email: normalizedEmail }, { username: username }] 
        });
        
        if (existingUser) {
            return res.status(409).json({ error: 'Email or username already used' });
        }

        // Create user
        const passwordHash = await bcrypt.hash(password, 12);
        const refCode = generateRefCode();
        let initialCoins = 0;
        let referrer = null;

        // Handle referral
        if (ref) {
            referrer = await User.findOne({ refCode: ref.toUpperCase() });
            if (referrer) {
                initialCoins = 1;
            }
        }

        const user = new User({
            username,
            email: normalizedEmail,
            passwordHash,
            fullName: username,
            walletBalance: initialCoins,
            refCode,
            referredBy: referrer ? referrer._id : null,
            emailVerified: true
        });

        await user.save();

        // Reward referrer
        if (referrer) {
            referrer.walletBalance += 2;
            referrer.transactions.push({
                type: 'referral',
                amount: 2,
                description: `Referral bonus for ${username}`,
                status: 'success'
            });
            await referrer.save();
        }

        const token = generateToken(user);

        res.json({
            success: true,
            message: 'Registration successful!',
            token,
            user: {
                _id: user._id,
                username: user.username,
                email: user.email,
                walletBalance: user.walletBalance,
                refCode: user.refCode
            }
        });

    } catch (error) {
        console.error('Register error:', error);
        res.status(500).json({ error: 'Server error during registration' });
    }
});

// Login
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        const normalizedEmail = email.toLowerCase();
        const user = await User.findOne({ email: normalizedEmail });

        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        if (user.isBanned) {
            return res.status(403).json({ error: 'Account has been banned' });
        }

        const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
        if (!isPasswordValid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = generateToken(user);

        res.json({
            success: true,
            token,
            user: {
                _id: user._id,
                username: user.username,
                email: user.email,
                walletBalance: user.walletBalance,
                refCode: user.refCode
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error during login' });
    }
});

// Get user profile
app.get('/api/profile', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const token = authHeader.replace('Bearer ', '');
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await User.findById(decoded.userId);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({
            success: true,
            user: {
                _id: user._id,
                username: user.username,
                email: user.email,
                walletBalance: user.walletBalance,
                totalDeposits: user.totalDeposits,
                totalSpent: user.totalSpent,
                refCode: user.refCode
            }
        });

    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ==================== DEPLOYMENT LOG HELPER ====================

async function processDeployment(payment) {
    const metadata = payment.metadata;
    const { appName, repoUrl, sessionId, teamName, userId, email } = metadata;

    const deployment = new Deployment({
        userId,
        email: email.toLowerCase(),
        appName: appName || `app-${uuidv4().slice(0, 8)}`,
        repoUrl,
        sessionId,
        teamName: teamName || HEROKU_TEAM,
        paymentReference: payment.reference,
        amountPaid: DEPLOYMENT_COST,
        deploymentStatus: 'pending',
        logs: [{ timestamp: new Date(), message: '🔥 Deployment initiated...', type: 'info' }]
    });
    await deployment.save();

    try {
        await addDeploymentLog(deployment._id, `📝 Deployment created for ${deployment.appName}`, 'info');
        await addDeploymentLog(deployment._id, `💰 Payment confirmed: KSH ${DEPLOYMENT_COST}`, 'success');

        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) throw new Error('User not found');

        if (user.walletBalance < DEPLOYMENT_COST) {
            throw new Error(`Insufficient balance. Required: KSH ${DEPLOYMENT_COST}, Available: KSH ${user.walletBalance}`);
        }

        await addDeploymentLog(deployment._id, `✅ Balance check passed. Available: KSH ${user.walletBalance}`, 'success');

        user.walletBalance -= DEPLOYMENT_COST;
        user.totalSpent += DEPLOYMENT_COST;
        user.transactions.push({
            type: 'deployment',
            amount: DEPLOYMENT_COST,
            reference: payment.reference,
            description: `Deployment of ${deployment.appName}`,
            status: 'success'
        });
        await user.save();

        await addDeploymentLog(deployment._id, `💰 KSH ${DEPLOYMENT_COST} deducted from wallet`, 'success');
        await addDeploymentLog(deployment._id, `📊 Remaining balance: KSH ${user.walletBalance}`, 'info');

        // Create Heroku app
        await addDeploymentLog(deployment._id, `🌐 Creating Heroku app: ${deployment.appName}...`, 'info');
        const createAppRes = await axios.post(
            'https://api.heroku.com/organizations/apps',
            { name: deployment.appName, organization: deployment.teamName },
            { headers: herokuHeaders }
        );
        await addDeploymentLog(deployment._id, `✅ Heroku app created: ${deployment.appName}`, 'success');
        await addDeploymentLog(deployment._id, `🔗 App URL: ${createAppRes.data.web_url}`, 'info');

        // Set config vars
        await addDeploymentLog(deployment._id, `⚙️ Setting configuration variables...`, 'info');
        await axios.patch(
            `https://api.heroku.com/apps/${deployment.appName}/config-vars`,
            {
                SESSION_ID: sessionId,
                TEAM_NAME: deployment.teamName,
                DEPLOYED_BY: email,
                DEPLOYMENT_DATE: new Date().toISOString()
            },
            { headers: herokuHeaders }
        );
        await addDeploymentLog(deployment._id, `✅ Configuration variables set`, 'success');

        // Trigger build
        await addDeploymentLog(deployment._id, `📦 Building from repository: ${repoUrl}`, 'info');
        const buildRes = await axios.post(
            `https://api.heroku.com/apps/${deployment.appName}/builds`,
            { source_blob: { url: repoUrl } },
            { headers: herokuHeaders }
        );

        deployment.buildId = buildRes.data.id;
        deployment.appUrl = createAppRes.data.web_url || `https://${deployment.appName}.herokuapp.com`;
        deployment.deploymentStatus = 'building';
        deployment.deployedAt = new Date();

        await addDeploymentLog(deployment._id, `✅ Build triggered: ${buildRes.data.id}`, 'success');
        await addDeploymentLog(deployment._id, `📊 Build status: ${buildRes.data.status}`, 'info');
        await addDeploymentLog(deployment._id, `⏳ Deployment in progress... This may take 3-5 minutes`, 'info');

        await deployment.save();

        await User.findByIdAndUpdate(userId, { $push: { deployments: deployment._id } });

        return deployment;

    } catch (error) {
        console.error('Deployment error:', error.message);
        deployment.deploymentStatus = 'failed';
        deployment.errorMessage = error.message;
        await addDeploymentLog(deployment._id, `❌ Deployment failed: ${error.message}`, 'error');
        await deployment.save();
        throw error;
    }
}

// ==================== API ENDPOINTS ====================

// 1. Initialize deposit
app.post('/api/deposit/initialize', async (req, res) => {
    try {
        const { email, amount, userId } = req.body;
        
        if (!email || !amount || !userId) {
            return res.status(400).json({ success: false, error: 'Email, amount, and userId are required' });
        }
        
        if (amount < 100) {
            return res.status(400).json({ success: false, error: 'Minimum deposit is 100 KSH' });
        }

        await findOrCreateUser(email);

        const reference = `DEPOSIT-${Date.now()}-${uuidv4().slice(0, 8)}`;
        const response = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: email.toLowerCase(),
                amount: amount * 100,
                reference,
                callback_url: `${APP_URL}/api/payment/verify/${reference}`,
                metadata: { userId, type: 'deposit', email: email.toLowerCase(), amount }
            },
            { headers: paystackHeaders }
        );

        if (response.data.status) {
            const payment = new Payment({
                userId,
                email: email.toLowerCase(),
                amount,
                reference,
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
                reference 
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

// 2. Verify payment
app.get('/api/payment/verify/:reference', async (req, res) => {
    try {
        const { reference } = req.params;
        const response = await axios.get(
            `https://api.paystack.co/transaction/verify/${reference}`,
            { headers: paystackHeaders }
        );

        if (response.data.status && response.data.data.status === 'success') {
            const paymentData = response.data.data;
            const metadata = paymentData.metadata || {};
            const payment = await Payment.findOneAndUpdate(
                { reference },
                { 
                    status: 'success', 
                    paymentDate: new Date(), 
                    metadata: { ...paymentData, ...metadata } 
                },
                { new: true }
            );

            if (payment && payment.type === 'deposit') {
                await User.findOneAndUpdate(
                    { email: payment.email },
                    {
                        $inc: { walletBalance: payment.amount, totalDeposits: payment.amount },
                        $push: {
                            transactions: {
                                type: 'deposit',
                                amount: payment.amount,
                                reference,
                                description: `Deposit of KSH ${payment.amount}`,
                                status: 'success'
                            }
                        }
                    },
                    { upsert: true, new: true }
                );
                return res.redirect(`${APP_URL}/wallet?status=success&amount=${payment.amount}`);
            }
            return res.redirect(`${APP_URL}/wallet?status=success`);
        } else {
            await Payment.findOneAndUpdate({ reference }, { status: 'failed' });
            return res.redirect(`${APP_URL}/wallet?status=failed`);
        }
    } catch (error) {
        console.error('Verify error:', error.message);
        res.redirect(`${APP_URL}/wallet?status=error`);
    }
});

// 3. Paystack Webhook
app.post('/api/payment/webhook', async (req, res) => {
    try {
        const signature = req.headers['x-paystack-signature'];
        const hash = crypto.createHmac('sha512', PAYSTACK_SECRET_KEY)
            .update(JSON.stringify(req.body))
            .digest('hex');
        if (hash !== signature) return res.status(401).send('Invalid signature');

        const event = req.body;
        if (event.event === 'charge.success') {
            const reference = event.data.reference;
            const payment = await Payment.findOneAndUpdate(
                { reference },
                { status: 'success', paymentDate: new Date(), metadata: event.data },
                { new: true }
            );
            if (payment && payment.type === 'deposit') {
                await User.findOneAndUpdate(
                    { email: payment.email },
                    {
                        $inc: { walletBalance: payment.amount, totalDeposits: payment.amount },
                        $push: {
                            transactions: {
                                type: 'deposit',
                                amount: payment.amount,
                                reference,
                                description: `Deposit of KSH ${payment.amount}`,
                                status: 'success'
                            }
                        }
                    },
                    { upsert: true }
                );
            } else if (payment && payment.type === 'deployment') {
                await processDeployment(payment);
            }
        }
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Webhook error:', error.message);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// 4. Deploy using wallet balance
app.post('/api/deploy', async (req, res) => {
    try {
        const { email, appName, repoUrl, sessionId, teamName } = req.body;
        
        if (!email || !appName || !repoUrl || !sessionId) {
            return res.status(400).json({ 
                success: false, 
                error: 'Email, appName, repoUrl, and sessionId are required' 
            });
        }

        const user = await findOrCreateUser(email);

        if (user.walletBalance < DEPLOYMENT_COST) {
            return res.status(400).json({
                success: false,
                error: 'Insufficient balance',
                balance: user.walletBalance,
                required: DEPLOYMENT_COST,
                message: `Please deposit at least KSH ${DEPLOYMENT_COST} to deploy.`
            });
        }

        const reference = `DEPLOY-${Date.now()}-${uuidv4().slice(0, 8)}`;
        const payment = new Payment({
            userId: user._id.toString(),
            email: email.toLowerCase(),
            amount: DEPLOYMENT_COST,
            reference,
            type: 'deployment',
            status: 'success',
            metadata: { 
                appName, 
                repoUrl, 
                sessionId, 
                teamName, 
                userId: user._id.toString(), 
                email: email.toLowerCase() 
            }
        });
        await payment.save();

        const deployment = await processDeployment(payment);

        res.json({
            success: true,
            message: 'Deployment started successfully!',
            deploymentId: deployment._id,
            appName: deployment.appName,
            appUrl: deployment.appUrl,
            buildId: deployment.buildId,
            dashboardUrl: `https://dashboard.heroku.com/teams/${deployment.teamName}/apps/${deployment.appName}`,
            balanceRemaining: user.walletBalance - DEPLOYMENT_COST,
            deploymentCost: DEPLOYMENT_COST,
            logsUrl: `/logs/${deployment._id}`
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

// 5. Get deployment logs
app.get('/api/deployment-logs/:deploymentId', async (req, res) => {
    try {
        const { deploymentId } = req.params;
        const deployment = await Deployment.findById(deploymentId);
        if (!deployment) {
            return res.status(404).json({ success: false, error: 'Deployment not found' });
        }
        res.json({
            success: true,
            deployment: {
                appName: deployment.appName,
                status: deployment.deploymentStatus,
                appUrl: deployment.appUrl,
                createdAt: deployment.createdAt,
                deployedAt: deployment.deployedAt,
                errorMessage: deployment.errorMessage
            },
            logs: deployment.logs
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch logs', details: error.message });
    }
});

// 6. Get all deployments for a user
app.get('/api/deployments/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const normalizedEmail = email.toLowerCase();
        
        await findOrCreateUser(normalizedEmail);
        
        const deployments = await Deployment.find({ email: normalizedEmail }).sort({ createdAt: -1 });
        
        res.json({
            success: true,
            count: deployments.length,
            deployments: deployments.map(d => ({
                id: d._id,
                appName: d.appName,
                status: d.deploymentStatus,
                appUrl: d.appUrl,
                amountPaid: d.amountPaid,
                createdAt: d.createdAt,
                deployedAt: d.deployedAt,
                logs: d.logs.slice(-5)
            }))
        });
    } catch (error) {
        console.error('Failed to fetch deployments:', error.message);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch deployments', 
            details: error.message 
        });
    }
});

// 7. Get wallet balance
app.get('/api/wallet/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const normalizedEmail = email.toLowerCase();
        
        const user = await findOrCreateUser(normalizedEmail);
        
        res.json({
            success: true,
            email: user.email,
            username: user.username,
            walletBalance: user.walletBalance,
            totalDeposits: user.totalDeposits,
            totalSpent: user.totalSpent,
            transactions: user.transactions.slice(-10),
            deploymentCount: user.deployments.length
        });
    } catch (error) {
        console.error('Failed to fetch wallet:', error.message);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch wallet', 
            details: error.message 
        });
    }
});

// 8. Get transactions
app.get('/api/transactions/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const normalizedEmail = email.toLowerCase();
        
        const user = await findOrCreateUser(normalizedEmail);
        
        res.json({ 
            success: true, 
            transactions: user.transactions.sort((a, b) => b.date - a.date) 
        });
    } catch (error) {
        console.error('Failed to fetch transactions:', error.message);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch transactions', 
            details: error.message 
        });
    }
});

// 9. Team info
app.get('/api/team-info', async (req, res) => {
    try {
        const teamName = req.query.team || HEROKU_TEAM;
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
        res.status(500).json({ success: false, error: 'Failed to fetch team info', details: error.response?.data || error.message });
    }
});

// 10. Build status
app.get('/api/build-status/:appName/:buildId', async (req, res) => {
    try {
        const { appName, buildId } = req.params;
        const buildRes = await axios.get(
            `https://api.heroku.com/apps/${appName}/builds/${buildId}`,
            { headers: herokuHeaders }
        );
        res.json({
            success: true,
            appName,
            buildId,
            status: buildRes.data.status,
            createdAt: buildRes.data.created_at,
            updatedAt: buildRes.data.updated_at
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch build status', details: error.response?.data || error.message });
    }
});

// 11. Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        service: 'CyberDark Host',
        version: '4.0.0',
        team: HEROKU_TEAM,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        mongodb: mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected',
        paystack: PAYSTACK_SECRET_KEY ? 'Configured' : 'Not Configured'
    });
});

// 12. Serve logs page
app.get('/logs/:deploymentId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'logs.html'));
});

// 13. Serve index page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Route not found', path: req.path });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error', details: err.message });
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
    console.log(`🔥 CyberDark Host running on port ${PORT}`);
    console.log(`📁 Default team: ${HEROKU_TEAM}`);
    console.log(`💰 Deployment cost: KSH ${DEPLOYMENT_COST}`);
    console.log(`📊 MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '❌ Disconnected'}`);
    console.log(`🌐 App URL: ${APP_URL}`);
});