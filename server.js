require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const HEROKU_API_KEY = process.env.HEROKU_API_KEY || '';
const GITHUB_REPO_TARBALL = 'https://github.com/KAMRAN-SMD/KAMRAN-MD/tarball/main';

app.use(express.static('public'));
app.use(express.json());

// Heroku API configuration
const herokuHeaders = {
    'Authorization': `Bearer ${HEROKU_API_KEY}`,
    'Accept': 'application/vnd.heroku+json; version=3',
    'Content-Type': 'application/json'
};

app.post('/deploy', async (req, res) => {
    const { sessionId, appName } = req.body;

    if (!sessionId) {
        return res.status(400).json({ error: 'SESSION_ID is required' });
    }

    const generatedAppName = appName?.trim()
        ? appName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
        : `subzero-${uuidv4().slice(0, 6)}`;

    try {
        // Step 1: Create Heroku app under iamricky team
        const createAppRes = await axios.post(
            'https://api.heroku.com/apps', 
            { 
                name: generatedAppName,
                organization: 'iamricky'  // Using organization for team deployment
            }, 
            { headers: herokuHeaders }
        );

        console.log('App created:', createAppRes.data);

        // Step 2: Set config vars
        await axios.patch(
            `https://api.heroku.com/apps/${generatedAppName}/config-vars`,
            { SESSION_ID: sessionId },
            { headers: herokuHeaders }
        );

        console.log('Config vars set');

        // Step 3: Trigger build
        await axios.post(
            `https://api.heroku.com/apps/${generatedAppName}/builds`,
            { source_blob: { url: GITHUB_REPO_TARBALL } },
            { headers: herokuHeaders }
        );

        console.log('Build triggered');

        res.json({ 
            success: true,
            message: 'Heroku deployment started!', 
            appName: generatedAppName,
            appUrl: `https://${generatedAppName}.herokuapp.com`,
            dashboardUrl: `https://dashboard.heroku.com/teams/iamricky/apps/${generatedAppName}`
        });

    } catch (error) {
        console.error('Deployment error:', error.response?.data || error.message);
        
        // More detailed error response
        const errorDetails = error.response?.data || error.message;
        const statusCode = error.response?.status || 500;
        
        res.status(statusCode).json({
            error: 'Heroku deployment failed',
            details: errorDetails,
            statusCode: statusCode
        });
    }
});

app.listen(PORT, () => {
    console.log(`Heroku Deployer running on port ${PORT}`);
    console.log(`Deploying to team: iamricky`);
});