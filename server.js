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

  // Strategy 1: Numeric ID fuzzing
  *numericIdFuzzer() {
    const numericPattern = /(\d+)/g;
    const matches = this.pathname.match(numericPattern);
    
    if (!matches) return;
    
    const lastNum = parseInt(matches[matches.length - 1]);
    
    for (let offset = -this.range; offset <= this.range; offset++) {
      if (offset === 0) continue;
      const newNum = lastNum + offset;
      if (newNum > 0) {
        yield this.baseUrl.replace(new RegExp(`\\b${lastNum}\\b`), newNum);
      }
    }
  }

  // Strategy 2: Hash variations
  *hashFuzzer() {
    const hashPatterns = [
      /[a-f0-9]{32}/i,
      /[a-f0-9]{40}/i,
      /[a-f0-9]{64}/i
    ];
    
    for (const pattern of hashPatterns) {
      const match = this.pathname.match(pattern);
      if (match) {
        const originalHash = match[0];
        const hashLength = originalHash.length;
        
        for (let i = 0; i < this.range; i++) {
          const randomHash = crypto.randomBytes(hashLength / 2).toString('hex').substring(0, hashLength);
          yield this.baseUrl.replace(originalHash, randomHash);
        }
        return;
      }
    }
  }

  // Strategy 3: Charset fuzzing
  *charsetFuzzer() {
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
    const hashPatterns = [/[a-zA-Z0-9_-]{10,}/];
    
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

  // Strategy 4: Date fuzzing
  *dateFuzzer() {
    const datePatterns = [
      /\d{4}-\d{2}-\d{2}/,
      /\d{8}/
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

  // Strategy 5: Padded ID fuzzing
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

// Smart content-aware HTTP client with duplicate detection
async function checkURL(url, timeout = 8000, retries = 2, contentHashMap = new Map()) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'image/*,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Referer': 'https://www.google.com/',
    'Sec-Fetch-Dest': 'image',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'cross-site',
    'DNT': '1'
  };

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      // Use GET to fetch actual content and detect duplicates
      const response = await axios.get(url, {
        timeout,
        maxRedirects: 3,
        validateStatus: (status) => status < 500,
        headers,
        responseType: 'arraybuffer',
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
      });
      
      // Ignore 304 Not Modified (cached responses)
      if (response.status === 304) {
        return {
          url,
          status: 304,
          found: false,
          contentLength: 0,
          contentType: 'cached',
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
          contentType: response.headers['content-type'] || 'unknown',
          hash: null,
          isDuplicate: false
        };
      }
      
      const contentLength = response.data.length;
      const contentType = response.headers['content-type'] || 'unknown';
      
      // Reject if not actually an image
      if (!contentType.includes('image/')) {
        return {
          url,
          status: 200,
          found: false,
          contentLength,
          contentType,
          hash: null,
          isDuplicate: false
        };
      }
      
      // Reject if too small (likely placeholder or error)
      if (contentLength < 1500) {
        return {
          url,
          status: 200,
          found: false,
          contentLength,
          contentType,
          hash: null,
          isDuplicate: false,
          reason: 'too_small'
        };
      }
      
      // Calculate MD5 hash of actual image content for deduplication
      const contentHash = crypto.createHash('md5').update(response.data).digest('hex');
      
      // Check if we've seen this exact image before
      const isDuplicate = contentHashMap.has(contentHash);
      
      if (!isDuplicate) {
        contentHashMap.set(contentHash, url);
      }
      
      return {
        url,
        status: 200,
        found: true,
        contentLength,
        contentType,
        hash: contentHash,
        isDuplicate,
        redirectUrl: response.request.path !== new URL(url).pathname ? response.config.url : null
      };
      
    } catch (error) {
      if (attempt === retries - 1) {
        return {
          url,
          status: 'timeout',
          found: false,
          contentLength: 0,
          error: error.message,
          hash: null,
          isDuplicate: false
        };
      }
      await new Promise(resolve => setTimeout(resolve, 500 * Math.pow(2, attempt)));
    }
  }
}

// Classify discovered URL
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
  const contentHashMap = new Map(); // Track unique image content
  
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
    const promises = batch.map(url => checkURL(url, 8000, 2, contentHashMap));
    
    const results = await Promise.all(promises);
    
    for (const result of results) {
      session.stats.scanned++;
      
      if (result.found) {
        const classification = classifyURL(result);
        session.stats[classification]++;
        
        // Only store genuinely new images (not duplicates)
        if (classification === 'new' || classification === 'placeholder') {
          session.results.push({
            url: result.url,
            status: result.status,
            contentType: result.contentType,
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
    const rate = Math.round(session.stats.scanned / (elapsed || 1));
    console.log(`[${sessionKey}] ${session.stats.scanned}/${urlQueue.length} | New: ${session.stats.new} | Placeholders: ${session.stats.placeholder} | Dupes: ${session.stats.duplicate} | Rate: ${rate} req/s`);
    
    if (i + concurrency < urlQueue.length && delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  console.log(`[${sessionKey}] Scan complete. Unique images: ${session.stats.new + session.stats.placeholder} (filtered ${session.stats.duplicate} duplicates)`);
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
