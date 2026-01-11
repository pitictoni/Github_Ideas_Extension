require('dotenv').config();
const express = require('express');
const cors = require('cors');
const https = require('https');

const app = express();

app.use(cors({
  origin: [
    'chrome-extension://${process.env.EXTENSION_ID}',
  ],
  methods: ['POST', 'GET'],
  credentials: true
}));

app.use(express.json());

//Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/github/token', async (req, res) => {
  const { code, redirect_uri } = req.body;

  if (!code) {
    return res.status(400).json({ error: 'Authorization code is required' });
  }

  if (!redirect_uri) {
    return res.status(400).json({ error: 'Redirect URI is required' });
  }

  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
    console.error('Missing required environment variables');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const postData = JSON.stringify({
    client_id: process.env.GITHUB_CLIENT_ID,
    client_secret: process.env.GITHUB_CLIENT_SECRET,
    code: code,
    redirect_uri: redirect_uri
  });

  console.log('Sending to GitHub:', {
    client_id: process.env.GITHUB_CLIENT_ID,
    client_secret: process.env.GITHUB_CLIENT_SECRET ? '***hidden***' : 'MISSING',
    code: code.substring(0, 4) + '...',
    redirect_uri: redirect_uri
  });

  const options = {
    hostname: 'github.com',
    port: 443,
    path: '/login/oauth/access_token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Chrome-Extension-OAuth-App',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  console.log('Request options:', options);

  const githubReq = https.request(options, (githubRes) => {
    let data = '';

    githubRes.on('data', (chunk) => {
      data += chunk;
    });

    githubRes.on('end', () => {
      console.log('GitHub response status:', githubRes.statusCode);
      console.log('GitHub response data:', data);
      
      try {
        const result = JSON.parse(data);

        //Check for errors from GitHub
        if (result.error) {
          console.error('GitHub OAuth error:', result);
          return res.status(400).json({ 
            error: result.error,
            message: result.error_description || 'OAuth exchange failed'
          });
        }

        if (!result.access_token) {
          console.error('No access token in response:', result);
          return res.status(400).json({ 
            error: 'no_token',
            message: 'No access token received from GitHub'
          });
        }

        //Return token
        res.json({
          access_token: result.access_token,
          token_type: result.token_type || 'bearer',
          scope: result.scope,
          expires_in: result.expires_in
        });
      } catch (err) {
        console.error('JSON parse error:', err);
        console.error('Raw response:', data);
        res.status(500).json({ 
          error: 'parse_error',
          message: 'GitHub returned non-JSON response: ' + data
        });
      }
    });
  });

  githubReq.on('error', (err) => {
    console.error('Request error details:', err);
    console.error('Error code:', err.code);
    console.error('Error message:', err.message);
    res.status(500).json({ 
      error: 'server_error',
      message: 'Failed to exchange authorization code for token: ' + err.message
    });
  });

  githubReq.write(postData);
  githubReq.end();
});

//Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'internal_error',
    message: 'An unexpected error occurred'
  });
});

const PORT = process.env.PORT;
app.listen(PORT, () => {
  console.log(`OAuth server running on port ${PORT}`);
  console.log(`Environment check:`);
  console.log(`GITHUB_CLIENT_ID: ${process.env.GITHUB_CLIENT_ID ? '✓' : '✗'}`);
  console.log(`GITHUB_CLIENT_SECRET: ${process.env.GITHUB_CLIENT_SECRET ? '✓' : '✗'}`);
});