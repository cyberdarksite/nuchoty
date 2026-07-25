import dotenv from 'dotenv';
import express from 'express';
import axios from 'axios';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';
import crypto from 'crypto';
import fs from 'fs';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Environment variables
const HEROKU_API_KEY = process.env.HEROKU_API_KEY || '';
const HEROKU_TEAM = process.env.HEROKU_TEAM || 'iamricky';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/cyberdark-host';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || '';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const DEPLOYMENT_COST = parseInt(process.env.DEPLOYMENT_COST) || 50;

// ==================== LOGGING SYSTEM ====================

const LOG_DIR = './logs';
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, TRACE: 4 };
const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';

function log(level, message, data = null) {
    const now = new Date();
    const timestamp = now.toISOString();
    const levelName = Object.keys(LOG_LEVELS).find(key => LOG_LEVELS[key] === level) || 'INFO';
    if (level > LOG_LEVELS[LOG_LEVEL]) return;
    const logEntry = `[${timestamp}] [${levelName}] ${message}${data ? ' | ' + JSON.stringify(data) : ''}\n`;
    const colors = { ERROR: '\x1b[31m', WARN: '\x1b[33m', INFO: '\x1b[36m', DEBUG: '\x1b[35m', TRACE: '\x1b[37m' };
    const reset = '\x1b[0m';
    console.log(`${colors[levelName] || ''}${logEntry}${reset}`);
    fs.appendFileSync(path.join(LOG_DIR, 'combined.log'), logEntry);
    if (level === LOG_LEVELS.ERROR) fs.appendFileSync(path.join(LOG_DIR, 'error.log'), logEntry);
}

// ==================== MIDDLEWARE ====================

app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== MONGODB CONNECTION ====================

mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    log(LOG_LEVELS.INFO, '✅ Connected to MongoDB');
}).catch(err => {
    log(LOG_LEVELS.ERROR, '❌ MongoDB connection error:', err.message);
});

// ==================== DATABASE SCHEMAS ====================

const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    fullName: { type: String, required: true },
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
    deployments: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Deployment' }]
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
    amountPaid: { type: Number, default: DEPLOYMENT_COST },
    deploymentStatus: {
        type: String,
        enum: ['pending', 'building', 'deployed', 'failed'],
        default: 'pending'
    },
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

// ==================== DEPLOYMENT LOG HELPER ====================

async function addDeploymentLog(deploymentId, message, type = 'info') {
    try {
        await Deployment.findByIdAndUpdate(deploymentId, {
            $push: { logs: { timestamp: new Date(), message, type } }
        });
    } catch (error) {
        log(LOG_LEVELS.ERROR, 'Failed to add deployment log:', error.message);
    }
}

// ==================== DEPLOYMENT PROCESS ====================

async function processDeployment(payment) {
    const metadata = payment.metadata;
    const { appName, repoUrl, sessionId, teamName, userId, email } = metadata;

    const deployment = new Deployment({
        userId,
        email,
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

        const user = await User.findOne({ email });
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

        await addDeploymentLog(deployment._id, `🌐 Creating Heroku app: ${deployment.appName}...`, 'info');
        const createAppRes = await axios.post(
            'https://api.heroku.com/organizations/apps',
            { name: deployment.appName, organization: deployment.teamName },
            { headers: herokuHeaders }
        );
        await addDeploymentLog(deployment._id, `✅ Heroku app created: ${deployment.appName}`, 'success');
        await addDeploymentLog(deployment._id, `🔗 App URL: ${createAppRes.data.web_url}`, 'info');

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
        log(LOG_LEVELS.ERROR, 'Deployment error:', error.message);
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

        const reference = `DEPOSIT-${Date.now()}-${uuidv4().slice(0, 8)}`;
        const response = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email,
                amount: amount * 100,
                reference,
                callback_url: `${APP_URL}/api/payment/verify/${reference}`,
                metadata: { userId, type: 'deposit', email, amount }
            },
            { headers: paystackHeaders }
        );

        if (response.data.status) {
            const payment = new Payment({
                userId, email, amount, reference, type: 'deposit',
                status: 'pending',
                metadata: { authorization_url: response.data.data.authorization_url, access_code: response.data.data.access_code }
            });
            await payment.save();
            return res.json({ success: true, authorization_url: response.data.data.authorization_url, reference });
        } else {
            return res.status(400).json({ success: false, error: response.data.message || 'Payment initialization failed' });
        }
    } catch (error) {
        log(LOG_LEVELS.ERROR, 'Deposit error:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: 'Failed to initialize deposit', details: error.response?.data || error.message });
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
                { status: 'success', paymentDate: new Date(), metadata: { ...paymentData, ...metadata } },
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
        log(LOG_LEVELS.ERROR, 'Verify error:', error.message);
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
        log(LOG_LEVELS.ERROR, 'Webhook error:', error.message);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// 4. Deploy using wallet balance
app.post('/api/deploy', async (req, res) => {
    try {
        const { email, appName, repoUrl, sessionId, teamName } = req.body;
        if (!email || !appName || !repoUrl || !sessionId) {
            return res.status(400).json({ success: false, error: 'Email, appName, repoUrl, and sessionId are required' });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).json({ success: false, error: 'User not found. Please deposit funds first.' });
        }

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
            email,
            amount: DEPLOYMENT_COST,
            reference,
            type: 'deployment',
            status: 'success',
            metadata: { appName, repoUrl, sessionId, teamName, userId: user._id.toString(), email }
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
        log(LOG_LEVELS.ERROR, 'Deployment error:', error.response?.data || error.message);
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
        const deployments = await Deployment.find({ email }).sort({ createdAt: -1 });
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
        res.status(500).json({ success: false, error: 'Failed to fetch deployments', details: error.message });
    }
});

// 7. Get wallet balance
app.get('/api/wallet/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        res.json({
            success: true,
            email: user.email,
            walletBalance: user.walletBalance,
            totalDeposits: user.totalDeposits,
            totalSpent: user.totalSpent,
            transactions: user.transactions.slice(-10),
            deploymentCount: user.deployments.length
        });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch wallet', details: error.message });
    }
});

// 8. Get transactions
app.get('/api/transactions/:email', async (req, res) => {
    try {
        const { email } = req.params;
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        res.json({ success: true, transactions: user.transactions.sort((a, b) => b.date - a.date) });
    } catch (error) {
        res.status(500).json({ success: false, error: 'Failed to fetch transactions', details: error.message });
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

// 404 handler
app.use((req, res) => {
    res.status(404).json({ success: false, error: 'Route not found', path: req.path });
});

// Error handler
app.use((err, req, res, next) => {
    log(LOG_LEVELS.ERROR, 'Unhandled error:', err.message);
    res.status(500).json({ success: false, error: 'Internal server error', details: err.message });
});

// Start server
app.listen(PORT, () => {
    log(LOG_LEVELS.INFO, `🔥 CyberDark Host running on port ${PORT}`);
    log(LOG_LEVELS.INFO, `📁 Default team: ${HEROKU_TEAM}`);
    log(LOG_LEVELS.INFO, `💰 Deployment cost: KSH ${DEPLOYMENT_COST}`);
    log(LOG_LEVELS.INFO, `📊 MongoDB: ${mongoose.connection.readyState === 1 ? '✅ Connected' : '❌ Disconnected'}`);
    log(LOG_LEVELS.INFO, `🌐 App URL: ${APP_URL}`);
});