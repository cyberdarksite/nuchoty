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

app.use(express.static('public'));
app.use(express.json());

// Heroku API configuration
const herokuHeaders = {
    'Authorization': `Bearer ${HEROKU_API_KEY}`,
    'Accept': 'application/vnd.heroku+json; version=3',
    'Content-Type': 'application/json'
};

app.post('/deploy', async (req, res) => {
    const { sessionId, appName, teamName } = req.body;

    if (!sessionId) {
        return res.status(400).json({ error: 'SESSION_ID is required' });
    }

    // Use team from request or fallback to environment variable
    const targetTeam = teamName || HEROKU_TEAM || 'iamricky';

    const generatedAppName = appName?.trim()
        ? appName.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')
        : `subzero-${uuidv4().slice(0, 6)}`;

    try {
        // Step 1: Create Heroku app in the team
        const createAppRes = await axios.post(
            'https://api.heroku.com/apps', 
            { 
                name: generatedAppName,
                organization: targetTeam // FIXED: Use 'organization' instead of 'team'
            }, 
            { headers: herokuHeaders }
        );

        console.log(`App created: ${generatedAppName} in team ${targetTeam}`);

        // Step 2: Set config vars
        await axios.patch(
            `https://api.heroku.com/apps/${generatedAppName}/config-vars`,
            { 
                SESSION_ID: sessionId,
                TEAM_NAME: targetTeam // Optional: Store team name for reference
            },
            { headers: herokuHeaders }
        );

        // Step 3: Trigger build
        const buildResponse = await axios.post(
            `https://api.heroku.com/apps/${generatedAppName}/builds`,
            { 
                source_blob: { 
                    url: GITHUB_REPO_TARBALL
                } 
            },
            { headers: herokuHeaders }
        );

        console.log(`Build triggered for ${generatedAppName}`);

        res.json({ 
            success: true,
            message: 'Heroku deployment started!', 
            appName: generatedAppName,
            appUrl: `https://${generatedAppName}.herokuapp.com`,
            team: targetTeam,
            dashboardUrl: `https://dashboard.heroku.com/teams/${targetTeam}/apps`,
            buildId: buildResponse.data.id,
            status: 'Building... (This takes 3-5 minutes)'
        });

    } catch (error) {
        console.error('Deployment error:', error.response?.data || error.message);
        
        // More detailed error handling
        let errorMessage = 'Heroku deployment failed';
        let details = error.response?.data || error.message;
        
        if (error.response?.status === 401) {
            errorMessage = 'Invalid Heroku API key. Please check your credentials.';
        } else if (error.response?.status === 422) {
            errorMessage = 'App name already taken or invalid. Please choose another name.';
            details = error.response?.data?.message || details;
        } else if (error.response?.status === 403) {
            errorMessage = 'You do not have permission to create apps in this team.';
        }

        res.status(500).json({
            error: errorMessage,
            details: details,
            status: error.response?.status
        });
    }
});

// Get team info endpoint
app.get('/team-info', async (req, res) => {
    try {
        const teamName = req.query.team || HEROKU_TEAM || 'iamricky';
        
        // Get team details
        const teamRes = await axios.get(
            `https://api.heroku.com/organizations/${teamName}`,
            { headers: herokuHeaders }
        );
        
        // Get team apps
        const appsRes = await axios.get(
            `https://api.heroku.com/apps?organization=${teamName}`,
            { headers: herokuHeaders }
        );

        res.json({
            team: teamRes.data,
            apps: appsRes.data.map(app => ({
                name: app.name,
                url: `https://${app.name}.herokuapp.com`,
                created_at: app.created_at,
                status: app.status || 'unknown'
            }))
        });
    } catch (error) {
        console.error('Team info error:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Failed to fetch team info',
            details: error.response?.data || error.message
        });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        team: HEROKU_TEAM || 'iamricky',
        timestamp: new Date().toISOString()
    });
});

app.listen(PORT, () => {
    console.log(`Heroku Deployer running on port ${PORT}`);
    console.log(`Default team: ${HEROKU_TEAM || 'iamricky'}`);
    console.log(`GitHub repo: ${GITHUB_REPO_TARBALL}`);
});