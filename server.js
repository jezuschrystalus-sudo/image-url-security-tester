const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const scanSessions = new Map();

// True hashcat brute force mode - exhaustive character enumeration
class HashcatBruteForceFuzzer {
  constructor(baseUrl, range, maskPositions = null) {
    this.baseUrl = baseUrl;
    this.range = range;
    this.urlObj = new URL(baseUrl);
    this.pathname = this.urlObj.pathname;
    this.maskPositions = maskPositions;
    
    // Character sets (like hashcat)
    this.charsets = {
      'l': 'abcdefghijklmnopqrstuvwxyz',
      'u': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      'd': '0123456789',
      'h': '0123456789abcdef',
      'H': '0123456789ABCDEF',
      's': ' !"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
      'a': 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      '?': 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'
    };
  }

  // Find hash-like tokens in URL
  findTokens() {
    const tokens = [];
    
    // Find long alphanumeric/hex sequences (20+ chars)
    const patterns = [
      { regex: /[a-f0-9]{20,}/gi, type: 'hex', charset: 'h' },
      { regex: /[A-Za-z0-9_-]{20,}/g, type: 'base64', charset: '?' }
    ];
    
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.regex.exec(this.pathname)) !== null) {
        // Check if not already found
        if (!tokens.some(t => t.index === match.index)) {
          tokens.push({
            value: match[0],
            index: match.index,
            type: pattern.type,
            charset: pattern.charset,
            length: match[0].length
          });
        }
      }
    }
    
    return tokens;
  }

  // Hashcat-style brute force: enumerate positions exhaustively
  *bruteForceFuzzer(token, charset = '?') {
    const charList = this.charsets[charset] || this.charsets['?'];
    const chars = token.split('');
    const numPositions = chars.length;
    
    // Start with limited positions to fuzz (e.g., last 6-8 characters)
    // This is like hashcat's --increment feature
    const fuzzyLength = Math.min(8, Math.max(3, Math.floor(numPositions / 4)));
    const startPos = numPositions - fuzzyLength;
    
    let iterations = 0;
    const maxIterations = this.range;
    
    // Generate combinations by incrementing positions
    let positions = new Array(fuzzyLength).fill(0);
    
    while (iterations < maxIterations) {
      // Create mutated token
      const mutated = [...chars];
      
      // Apply current position values to fuzz zone
      for (let i = 0; i < fuzzyLength; i++) {
        mutated[startPos + i] = charList[positions[i] % charList.length];
      }
      
      const newToken = mutated.join('');
      if (newToken !== token) {
        yield this.baseUrl.replace(token, newToken);
      }
      
      // Increment positions (like odometer: rightmost first)
      let carry = 1;
      for (let i = fuzzyLength - 1; i >= 0 && carry; i--) {
        positions[i] += carry;
        if (positions[i] >= charList.length) {
          positions[i] = 0;
          carry = 1;
        } else {
          carry = 0;
        }
      }
      
      iterations++;
    }
  }

  // Hybrid: partially increment, partially random
  *hybridBruteFuzzer(token, charset = '?') {
    const charList = this.charsets[charset] || this.charsets['?'];
    const chars = token.split('');
    const numPositions = chars.length;
    
    // Divide into fixed and variable zones
    const fixedSize = Math.max(0, numPositions - 6);
    const varSize = numPositions - fixedSize;
    
    let iterations = 0;
    let posCounter = new Array(varSize).fill(0);
    
    while (iterations < this.range) {
      const mutated = [...chars];
      
      // Keep prefix fixed, enumerate suffix
      for (let i = 0; i < varSize; i++) {
        mutated[fixedSize + i] = charList[posCounter[i] % charList.length];
      }
      
      const newToken = mutated.join('');
      if (newToken !== token) {
        yield this.baseUrl.replace(token, newToken);
      }
      
      // Increment counter
      let carry = 1;
      for (let i = varSize - 1; i >= 0 && carry; i--) {
        posCounter[i] += carry;
        if (posCounter[i] >= charList.length) {
          posCounter[i] = 0;
          carry = 1;
        } else {
          carry = 0;
        }
      }
      
      iterations++;
    }
  }

  // Generate all variations
  *generateAll() {
    const tokens = this.findTokens();
    console.log(`Found ${tokens.length} token(s) for brute force`);
    
    if (tokens.length === 0) return;
    
    // Fuzz each token
    for (const token of tokens) {
      console.log(`Brute forcing token: ${token.value.substring(0, 10)}... (type: ${token.type}, length: ${token.length})`);
      
      // Use hybrid approach: incremental + some randomness
      let generated = 0;
      const tokenRange = Math.floor(this.range / tokens.length);
      
      for (const url of this.hybridBruteFuzzer(token.value, token.charset)) {
        if (generated >= tokenRange) break;
        yield url;
        generated++;
      }
    }
  }
}

// Smart content-aware HTTP client
async function checkURL(url, timeout = 6000, retries = 1, contentHashMap = new Map()) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'image/*,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Referer': 'https://www.google.com/',
    'DNT': '1'
  };

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout,
        maxRedirects: 2,
        validateStatus: (status) => status < 500,
        headers,
        responseType: 'arraybuffer',
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
      });
      
      // Ignore 304 Not Modified
      if (response.status === 304) {
        return {
          url,
          status: 304,
          found: false,
          contentLength: 0,
          hash: null,
          isDuplicate: false
        };
      }
      
      // Only accept 200 OK
      if (response.status !== 200) {
        return {
          url,
          status: response.status,
          found: false,
          contentLength: 0,
          hash: null,
          isDuplicate: false
        };
      }
      
      const contentLength = response.data.length;
      const contentType = response.headers['content-type'] || 'unknown';
      
      // Must be image
      if (!contentType.includes('image/')) {
        return {
          url,
          status: 200,
          found: false,
          contentLength,
          hash: null,
          isDuplicate: false
        };
      }
      
      // Reject tiny files (placeholders/errors)
      if (contentLength < 1500) {
        return {
          url,
          status: 200,
          found: false,
          contentLength,
          hash: null,
          isDuplicate: false
        };
      }
      
      // Hash content for dedup
      const contentHash = crypto.createHash('md5').update(response.data).digest('hex');
      const isDuplicate = contentHashMap.has(contentHash);
      
      if (!isDuplicate) {
        contentHashMap.set(contentHash, url);
      }
      
      return {
        url,
        status: 200,
        found: true,
        contentLength,
        hash: contentHash,
        isDuplicate,
        contentType
      };
      
    } catch (error) {
      if (attempt === retries - 1) {
        return {
          url,
          status: 'timeout',
          found: false,
          contentLength: 0,
          hash: null,
          isDuplicate: false
        };
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
}

// Classify result
function classifyURL(data) {
  if (!data.found) return 'error';
  if (data.isDuplicate) return 'duplicate';
  if (data.contentLength < 3000) return 'placeholder';
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
      stats: { scanned: 0, new: 0, placeholder: 0, duplicate: 0, error: 0 },
      startTime: Date.now()
    });
  }
  
  res.json({ sessionId: sessionKey });
  
  performBruteForceScan(urls, range, delay, concurrency, maxRequests, sessionKey);
});

// Perform brute force scan
async function performBruteForceScan(referenceUrls, range, delay, concurrency, maxRequests, sessionKey) {
  const session = scanSessions.get(sessionKey);
  if (!session) return;
  
  let totalGenerated = 0;
  const urlQueue = [];
  const seenUrls = new Set(referenceUrls);
  const contentHashMap = new Map();
  
  // Generate brute force mutations
  for (const baseUrl of referenceUrls) {
    const bruteForcer = new HashcatBruteForceFuzzer(baseUrl, range);
    
    console.log(`[${sessionKey}] Starting hashcat brute force on: ${baseUrl}`);
    
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
  
  console.log(`[${sessionKey}] Generated ${totalGenerated} brute force URLs (keyspace enumeration)`);
  
  // Process with concurrency
  for (let i = 0; i < urlQueue.length; i += concurrency) {
    if (!session.active) break;
    
    const batch = urlQueue.slice(i, i + concurrency);
    const promises = batch.map(url => checkURL(url, 6000, 1, contentHashMap));
    
    const results = await Promise.all(promises);
    
    for (const result of results) {
      session.stats.scanned++;
      
      if (result.found) {
        const classification = classifyURL(result);
        session.stats[classification]++;
        
        if (classification === 'new' || classification === 'placeholder') {
          session.results.push({
            url: result.url,
            status: result.status,
            contentLength: result.contentLength,
            hash: result.hash,
            classification,
            timestamp: new Date()
          });
        }
      } else {
        session.stats.error++;
      }
    }
    
    const elapsed = Math.round((Date.now() - session.startTime) / 1000);
    const rate = elapsed > 0 ? Math.round(session.stats.scanned / elapsed) : 0;
    console.log(`[${sessionKey}] ${session.stats.scanned}/${urlQueue.length} | New: ${session.stats.new} | Dupes: ${session.stats.duplicate} | Rate: ${rate} req/s`);
    
    if (i + concurrency < urlQueue.length && delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  console.log(`[${sessionKey}] Brute force complete. Found ${session.stats.new} unique new images`);
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
  console.log(`🔓 Image URL Brute Forcer (Hashcat Mode) running on http://localhost:${PORT}`);
});
