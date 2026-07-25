require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const HEROKU_API_KEY = process.env.HEROKU_API_KEY || '';
const HEROKU_TEAM = process.env.HEROKU_TEAM || 'iamricky';
const GITHUB_REPO_TARBALL = 'https://github.com/KAMRAN-SMD/KAMRAN-MD/tarball/main';

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Heroku API configuration
const herokuHeaders = {
    'Authorization': `Bearer ${HEROKU_API_KEY}`,
    'Accept': 'application/vnd.heroku+json; version=3',
    'Content-Type': 'application/json'
};

// Serve the main HTML page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Deploy endpoint
app.post('/deploy', async (req, res) => {
    const { sessionId, appName, teamName } = req.body;

    // Validate required fields
    if (!sessionId) {
        return res.status(400).json({ 
            success: false,
            error: 'SESSION_ID is required' 
        });
    }

    // Use team from request or fallback to environment variable
    const targetTeam = teamName || HEROKU_TEAM || 'iamricky';

    // Generate app name (if not provided)
    const generatedAppName = appName?.trim()
        ? appName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
        : `app-${uuidv4().slice(0, 8)}`;

    try {
        console.log(`🚀 Starting deployment for app: ${generatedAppName}`);
        console.log(`📁 Team: ${targetTeam}`);
        console.log(`🔑 Session ID: ${sessionId.substring(0, 10)}...`);

        // Step 1: Create Heroku app in the team
        const createAppRes = await axios.post(
            'https://api.heroku.com/organizations/apps', // ✅ CORRECT ENDPOINT
            {
                name: generatedAppName,
                organization: targetTeam // ✅ CORRECT PARAMETER
            },
            { headers: herokuHeaders }
        );

        console.log(`✅ App created: ${generatedAppName}`);
        console.log(`🔗 App URL: ${createAppRes.data.web_url}`);

        // Step 2: Set config vars (SESSION_ID, etc.)
        await axios.patch(
            `https://api.heroku.com/apps/${generatedAppName}/config-vars`,
            { 
                SESSION_ID: sessionId,
                TEAM_NAME: targetTeam,
                DEPLOYED_BY: 'Heroku-Deployer'
            },
            { headers: herokuHeaders }
        );

        console.log(`✅ Config vars set for ${generatedAppName}`);

        // Step 3: Trigger build from GitHub
        const buildRes = await axios.post(
            `https://api.heroku.com/apps/${generatedAppName}/builds`,
            {
                source_blob: {
                    url: GITHUB_REPO_TARBALL
                }
            },
            { headers: herokuHeaders }
        );

        console.log(`✅ Build triggered: ${buildRes.data.id}`);
        console.log(`📊 Build status: ${buildRes.data.status}`);

        // Step 4: Return success response
        res.json({
            success: true,
            message: 'Deployment started successfully!',
            appName: generatedAppName,
            appUrl: createAppRes.data.web_url || `https://${generatedAppName}.herokuapp.com`,
            gitUrl: createAppRes.data.git_url,
            team: targetTeam,
            buildId: buildRes.data.id,
            buildStatus: buildRes.data.status,
            dashboardUrl: `https://dashboard.heroku.com/teams/${targetTeam}/apps/${generatedAppName}`,
            outputStreamUrl: buildRes.data.output_stream_url,
            createdAt: createAppRes.data.created_at,
            region: createAppRes.data.region?.name || 'us'
        });

    } catch (error) {
        console.error('❌ Deployment error:', error.response?.data || error.message);
        
        // Enhanced error handling
        let errorMessage = 'Heroku deployment failed';
        let details = error.response?.data || error.message;
        let statusCode = error.response?.status || 500;

        if (statusCode === 401) {
            errorMessage = 'Invalid Heroku API key. Please check your credentials.';
            details = 'The API key provided is not valid or has expired.';
        } else if (statusCode === 403) {
            errorMessage = 'Permission denied. You do not have access to this team.';
            details = 'Make sure you are a member of the specified team.';
        } else if (statusCode === 422) {
            errorMessage = 'Invalid app name or app already exists.';
            details = error.response?.data?.message || 'Please choose a different app name.';
        } else if (statusCode === 429) {
            errorMessage = 'Rate limit exceeded. Please wait a few minutes.';
            details = 'Heroku API rate limit has been reached.';
        }

        res.status(statusCode).json({
            success: false,
            error: errorMessage,
            details: details,
            statusCode: statusCode,
            timestamp: new Date().toISOString()
        });
    }
});

// Get team information endpoint
app.get('/team-info', async (req, res) => {
    try {
        const teamName = req.query.team || HEROKU_TEAM || 'iamricky';
        
        console.log(`📊 Fetching info for team: ${teamName}`);

        // Get team apps
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
                updatedAt: app.updated_at,
                status: app.status || 'unknown',
                region: app.region?.name || 'us',
                stack: app.stack?.name || 'heroku-24'
            }))
        });

    } catch (error) {
        console.error('❌ Team info error:', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch team information',
            details: error.response?.data || error.message
        });
    }
});

// Get build status endpoint
app.get('/build-status/:appName/:buildId', async (req, res) => {
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
            updatedAt: buildRes.data.updated_at,
            outputStreamUrl: buildRes.data.output_stream_url
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to fetch build status',
            details: error.response?.data || error.message
        });
    }
});

// List all apps in team
app.get('/apps', async (req, res) => {
    try {
        const teamName = req.query.team || HEROKU_TEAM || 'iamricky';
        
        const appsRes = await axios.get(
            `https://api.heroku.com/teams/${teamName}/apps`,
            { headers: herokuHeaders }
        );

        res.json({
            success: true,
            team: teamName,
            total: appsRes.data.length,
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
            error: 'Failed to list apps',
            details: error.response?.data || error.message
        });
    }
});

// Delete app endpoint (use with caution)
app.delete('/apps/:appName', async (req, res) => {
    try {
        const { appName } = req.params;
        const confirm = req.query.confirm === 'yes';

        if (!confirm) {
            return res.status(400).json({
                success: false,
                error: 'Please confirm deletion with ?confirm=yes'
            });
        }

        await axios.delete(
            `https://api.heroku.com/apps/${appName}`,
            { headers: herokuHeaders }
        );

        res.json({
            success: true,
            message: `App ${appName} deleted successfully`
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Failed to delete app',
            details: error.response?.data || error.message
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        service: 'Heroku Deployer',
        version: '2.0.0',
        team: HEROKU_TEAM || 'iamricky',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage()
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
    console.log(`🚀 Heroku Deployer running on port ${PORT}`);
    console.log(`📁 Default team: ${HEROKU_TEAM || 'iamricky'}`);
    console.log(`📦 GitHub repo: ${GITHUB_REPO_TARBALL}`);
    console.log(`🔗 Dashboard: https://dashboard.heroku.com/teams/${HEROKU_TEAM || 'iamricky'}/apps`);
    console.log(`✅ Server is ready to deploy apps!`);
});