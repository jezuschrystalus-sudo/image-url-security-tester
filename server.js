const express = require('express');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// Store for tracking found URLs and their hashes
const imageCache = new Map();
const scanSessions = new Map();

// Generate variations of URL
function generateURLVariations(baseUrl, range) {
  const variations = [];
  const urlObj = new URL(baseUrl);
  const pathname = urlObj.pathname;
  
  // Extract numeric parts and create variations
  const numericPattern = /(\d+)/g;
  const matches = pathname.match(numericPattern);
  
  if (matches) {
    const baseNum = parseInt(matches[0]);
    for (let i = 1; i <= range; i++) {
      const newNum = baseNum + i;
      const newUrl = baseUrl.replace(/\d+/, newNum);
      variations.push(newUrl);
    }
  }
  
  return variations;
}

// Check if image exists and is valid
async function checkImage(url, timeout = 5000) {
  try {
    const response = await axios.head(url, {
      timeout,
      maxRedirects: 5,
      validateStatus: (status) => status < 500
    });
    
    if (response.status === 200) {
      const contentType = response.headers['content-type'] || '';
      const contentLength = response.headers['content-length'] || 0;
      const hash = crypto.createHash('md5').update(url).digest('hex');
      
      return {
        status: response.status,
        contentType,
        contentLength: parseInt(contentLength),
        url,
        hash,
        found: true
      };
    }
    
    return {
      status: response.status,
      found: false,
      url
    };
  } catch (error) {
    return {
      status: 'error',
      error: error.message,
      found: false,
      url
    };
  }
}

// Classify result
function classifyResult(data, knownUrls) {
  if (!data.found) return 'error';
  if (knownUrls.some(u => u === data.url)) return 'duplicate';
  if (data.contentLength < 5000) return 'placeholder';
  return 'new';
}

// Main scan endpoint
app.post('/api/scan', async (req, res) => {
  const { referenceUrls, range, delay, concurrency, maxRequests, sessionId } = req.body;
  
  if (!referenceUrls || referenceUrls.length === 0) {
    return res.status(400).json({ error: 'No reference URLs provided' });
  }
  
  const urls = referenceUrls.filter(u => u.trim());
  const sessionKey = sessionId || crypto.randomBytes(16).toString('hex');
  
  if (!scanSessions.has(sessionKey)) {
    scanSessions.set(sessionKey, {
      active: true,
      results: [],
      stats: { scanned: 0, new: 0, placeholder: 0, duplicate: 0, error: 0 }
    });
  }
  
  res.json({ sessionId: sessionKey });
  
  // Start scanning in background
  performScan(urls, range, delay, concurrency, maxRequests, sessionKey);
});

// Perform actual scanning
async function performScan(referenceUrls, range, delay, concurrency, maxRequests, sessionKey) {
  const session = scanSessions.get(sessionKey);
  if (!session) return;
  
  const queue = [];
  const knownUrls = new Set(referenceUrls);
  let scanned = 0;
  
  // Generate all variations
  for (const url of referenceUrls) {
    const variations = generateURLVariations(url, range);
    queue.push(...variations);
  }
  
  // Limit requests
  const urlsToCheck = queue.slice(0, Math.min(maxRequests, queue.length));
  
  // Process with concurrency limit
  for (let i = 0; i < urlsToCheck.length; i += concurrency) {
    if (!session.active) break;
    
    const batch = urlsToCheck.slice(i, i + concurrency);
    const promises = batch.map(url => checkImage(url));
    
    const results = await Promise.all(promises);
    
    for (const result of results) {
      const classification = classifyResult(result, Array.from(knownUrls));
      
      if (result.found) {
        session.results.push({
          url: result.url,
          status: result.status,
          contentType: result.contentType,
          contentLength: result.contentLength,
          classification,
          timestamp: new Date()
        });
        
        session.stats[classification]++;
      } else if (classification === 'error') {
        session.stats.error++;
      }
      
      session.stats.scanned++;
      scanned++;
    }
    
    // Add delay between batches
    if (i + concurrency < urlsToCheck.length) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  session.active = false;
}

// Get scan progress endpoint
app.get('/api/progress/:sessionId', (req, res) => {
  const session = scanSessions.get(req.params.sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  res.json({
    active: session.active,
    stats: session.stats,
    results: session.results.slice(-50), // Return last 50 results
    totalResults: session.results.length
  });
});

// Stop scan endpoint
app.post('/api/stop/:sessionId', (req, res) => {
  const session = scanSessions.get(req.params.sessionId);
  
  if (session) {
    session.active = false;
  }
  
  res.json({ success: true });
});

// Export results endpoint
app.get('/api/export/:sessionId', (req, res) => {
  const session = scanSessions.get(req.params.sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  res.json(session.results);
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
