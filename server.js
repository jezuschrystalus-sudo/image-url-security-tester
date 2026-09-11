const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const scanSessions = new Map();

// Hashcat-style URL generators
class URLBruteForcer {
  constructor(baseUrl, range) {
    this.baseUrl = baseUrl;
    this.range = range;
    this.urlObj = new URL(baseUrl);
    this.pathname = this.urlObj.pathname;
  }

  // Strategy 1: Numeric ID fuzzing (e.g., /image/123.jpg -> /image/124.jpg, 125.jpg, etc)
  *numericIdFuzzer() {
    const numericPattern = /(\d+)/g;
    const matches = this.pathname.match(numericPattern);
    
    if (!matches) return;
    
    const lastNum = parseInt(matches[matches.length - 1]);
    
    // Fuzz upward and downward
    for (let offset = -this.range; offset <= this.range; offset++) {
      if (offset === 0) continue;
      const newNum = lastNum + offset;
      if (newNum > 0) {
        yield this.baseUrl.replace(new RegExp(`\\b${lastNum}\\b`), newNum);
      }
    }
  }

  // Strategy 2: Hash variations (MD5, SHA1 style)
  *hashFuzzer() {
    const hashPatterns = [
      /[a-f0-9]{32}/i,  // MD5
      /[a-f0-9]{40}/i,  // SHA1
      /[a-f0-9]{64}/i   // SHA256
    ];
    
    for (const pattern of hashPatterns) {
      const match = this.pathname.match(pattern);
      if (match) {
        const originalHash = match[0];
        const hashLength = originalHash.length;
        
        // Generate variations
        for (let i = 0; i < this.range; i++) {
          const randomHash = crypto.randomBytes(hashLength / 2).toString('hex').substring(0, hashLength);
          yield this.baseUrl.replace(originalHash, randomHash);
        }
        return;
      }
    }
  }

  // Strategy 3: Character set fuzzing (alphanumeric substitution)
  *charsetFuzzer() {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
    const hashPatterns = [
      /[a-zA-Z0-9_-]{10,}/
    ];
    
    for (const pattern of hashPatterns) {
      const matches = this.pathname.match(pattern);
      if (matches) {
        for (let i = 0; i < this.range; i++) {
          let randomString = '';
          for (let j = 0; j < matches[0].length; j++) {
            randomString += charset[Math.floor(Math.random() * charset.length)];
          }
          yield this.baseUrl.replace(matches[0], randomString);
        }
        return;
      }
    }
  }

  // Strategy 4: Date/timestamp fuzzing
  *dateFuzzer() {
    const datePatterns = [
      /\d{4}-\d{2}-\d{2}/,  // YYYY-MM-DD
      /\d{8}/               // YYYYMMDD
    ];
    
    for (const pattern of datePatterns) {
      const match = this.pathname.match(pattern);
      if (match) {
        const baseDate = new Date();
        
        for (let i = -this.range; i <= this.range; i++) {
          const newDate = new Date(baseDate);
          newDate.setDate(newDate.getDate() + i);
          
          let dateStr;
          if (pattern.test('2023-01-01')) {
            dateStr = newDate.toISOString().split('T')[0];
          } else {
            dateStr = newDate.toISOString().split('T')[0].replace(/-/g, '');
          }
          
          if (dateStr !== match[0]) {
            yield this.baseUrl.replace(match[0], dateStr);
          }
        }
        return;
      }
    }
  }

  // Strategy 5: Sequential ID with padding
  *paddedIdFuzzer() {
    const paddedPattern = /\d{4,8}/;
    const match = this.pathname.match(paddedPattern);
    
    if (match) {
      const baseNum = parseInt(match[0]);
      const padding = match[0].length;
      
      for (let offset = -this.range; offset <= this.range; offset++) {
        if (offset === 0) continue;
        const newNum = baseNum + offset;
        if (newNum > 0) {
          const paddedNum = String(newNum).padStart(padding, '0');
          yield this.baseUrl.replace(match[0], paddedNum);
        }
      }
    }
  }

  // Generate all variations
  *generateAll() {
    yield* this.numericIdFuzzer();
    yield* this.hashFuzzer();
    yield* this.charsetFuzzer();
    yield* this.dateFuzzer();
    yield* this.paddedIdFuzzer();
  }
}

// Check if URL returns 200 and has content
async function checkURL(url, timeout = 3000) {
  try {
    const response = await axios.head(url, {
      timeout,
      maxRedirects: 2,
      validateStatus: () => true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const contentLength = parseInt(response.headers['content-length'] || 0);
    
    return {
      url,
      status: response.status,
      found: response.status === 200,
      contentLength,
      contentType: response.headers['content-type'] || 'unknown'
    };
  } catch (error) {
    return {
      url,
      status: 'timeout',
      found: false,
      contentLength: 0,
      error: error.message
    };
  }
}

// Classify discovered URL
function classifyURL(data) {
  if (!data.found) return 'error';
  
  // Check if it's actually an image
  if (!data.contentType.includes('image')) {
    return 'non-image';
  }
  
  // Placeholder detection (very small images)
  if (data.contentLength < 2000) {
    return 'placeholder';
  }
  
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
      stats: { scanned: 0, new: 0, placeholder: 0, 'non-image': 0, error: 0 },
      startTime: Date.now()
    });
  }
  
  res.json({ sessionId: sessionKey });
  
  // Start scanning in background
  performBruteForceScan(urls, range, delay, concurrency, maxRequests, sessionKey);
});

// Perform brute force scan
async function performBruteForceScan(referenceUrls, range, delay, concurrency, maxRequests, sessionKey) {
  const session = scanSessions.get(sessionKey);
  if (!session) return;
  
  let totalGenerated = 0;
  const urlQueue = [];
  const seenUrls = new Set(referenceUrls);
  
  // Generate URLs from all reference URLs
  for (const baseUrl of referenceUrls) {
    const bruteForcer = new URLBruteForcer(baseUrl, range);
    
    for (const url of bruteForcer.generateAll()) {
      if (!seenUrls.has(url) && urlQueue.length < maxRequests) {
        urlQueue.push(url);
        seenUrls.add(url);
        totalGenerated++;
        
        if (totalGenerated >= maxRequests) break;
      }
    }
    
    if (totalGenerated >= maxRequests) break;
  }
  
  console.log(`[${sessionKey}] Generated ${totalGenerated} URL variations to brute force`);
  
  // Process queue with concurrency
  for (let i = 0; i < urlQueue.length; i += concurrency) {
    if (!session.active) break;
    
    const batch = urlQueue.slice(i, i + concurrency);
    const promises = batch.map(url => checkURL(url));
    
    const results = await Promise.all(promises);
    
    for (const result of results) {
      session.stats.scanned++;
      
      if (result.found) {
        const classification = classifyURL(result);
        session.stats[classification]++;
        
        // Only store successful finds (not errors)
        if (classification !== 'error' && classification !== 'non-image') {
          session.results.push({
            url: result.url,
            status: result.status,
            contentType: result.contentType,
            contentLength: result.contentLength,
            classification,
            timestamp: new Date()
          });
        }
      } else {
        session.stats.error++;
      }
    }
    
    // Progress logging
    const elapsed = Math.round((Date.now() - session.startTime) / 1000);
    const rate = Math.round(session.stats.scanned / elapsed);
    console.log(`[${sessionKey}] ${session.stats.scanned}/${urlQueue.length} | New: ${session.stats.new} | Placeholders: ${session.stats.placeholder} | Rate: ${rate} req/s`);
    
    // Delay between batches
    if (i + concurrency < urlQueue.length && delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  console.log(`[${sessionKey}] Brute force complete. Found ${session.stats.new} new images, ${session.stats.placeholder} placeholders`);
  session.active = false;
}

// Get progress
app.get('/api/progress/:sessionId', (req, res) => {
  const session = scanSessions.get(req.params.sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  res.json({
    active: session.active,
    stats: session.stats,
    results: session.results.slice(-50),
    totalResults: session.results.length
  });
});

// Stop scan
app.post('/api/stop/:sessionId', (req, res) => {
  const session = scanSessions.get(req.params.sessionId);
  
  if (session) {
    session.active = false;
  }
  
  res.json({ success: true });
});

// Export results
app.get('/api/export/:sessionId', (req, res) => {
  const session = scanSessions.get(req.params.sessionId);
  
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  res.json(session.results);
});

app.listen(PORT, () => {
  console.log(`🔓 Image URL Brute Forcer running on http://localhost:${PORT}`);
});
