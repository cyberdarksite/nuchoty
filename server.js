require('dotenv').config();
const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Heroku = require('heroku');

const app = express();
const PORT = process.env.PORT || 3000;
const HEROKU_API_KEY = process.env.HEROKU_API_KEY || '';
const GITHUB_REPO_TARBALL = 'https://github.com/KAMRAN-SMD/KAMRAN-MD/tarball/main';

// Initialize Heroku client
const heroku = new Heroku({ token: HEROKU_API_KEY });

app.use(express.static('public'));
app.use(express.json());

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/deploy', async (req, res) => {
    const { sessionId, appName } = req.body;

    if (!sessionId) {
        return res.status(400).json({ 
            success: false,
            error: 'SESSION_ID is required' 
        });
    }

    if (!HEROKU_API_KEY) {
        return res.status(400).json({
            success: false,
            error: 'HEROKU_API_KEY is not configured'
        });
    }

    const generatedAppName = appName?.trim()
        ? appName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
        : `subzero-${uuidv4().slice(0, 6)}`;

    try {
        // Step 1: Create Heroku app under iamricky team
        console.log(`Creating app: ${generatedAppName} under iamricky team`);
        
        const createApp = await heroku.post('/apps', {
            name: generatedAppName,
            organization: 'iamricky'
        });

        console.log('App created:', createApp.id);

        // Step 2: Set config vars
        await heroku.patch(`/apps/${generatedAppName}/config-vars`, {
            body: { 
                SESSION_ID: sessionId,
                HEROKU_API_KEY: HEROKU_API_KEY
            }
        });

        console.log('Config vars set');

        // Step 3: Trigger build from GitHub tarball
        await heroku.post(`/apps/${generatedAppName}/builds`, {
            body: { 
                source_blob: { 
                    url: GITHUB_REPO_TARBALL 
                } 
            }
        });

        console.log('Build triggered');

        res.json({ 
            success: true,
            message: 'Heroku deployment started successfully!',
            appName: generatedAppName,
            appUrl: `https://${generatedAppName}.herokuapp.com`,
            dashboardUrl: `https://dashboard.heroku.com/teams/iamricky/apps/${generatedAppName}`,
            buildLogs: `https://dashboard.heroku.com/teams/iamricky/apps/${generatedAppName}/activity`
        });

    } catch (error) {
        console.error('Deployment error:', error.body || error.message);
        
        // Handle verification required error
        if (error.body && error.body.id === 'verification_required') {
            return res.status(422).json({
                success: false,
                error: 'Team verification required',
                message: 'The iamricky team needs to be verified with payment information',
                verifyUrl: 'https://dashboard.heroku.com/teams/iamricky/settings',
                details: error.body
            });
        }

        // Handle other errors
        res.status(500).json({
            success: false,
            error: 'Heroku deployment failed',
            details: error.body || error.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`Heroku Deployer running on port ${PORT}`);
    console.log(`Deploying to team: iamricky`);
    console.log(`API Key configured: ${HEROKU_API_KEY ? 'Yes' : 'No'}`);
});