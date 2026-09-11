const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const scanSessions = new Map();

// Hashcat-style mask-based URL fuzzer
class MaskBasedBruteForcer {
  constructor(baseUrl, range) {
    this.baseUrl = baseUrl;
    this.range = range;
    this.urlObj = new URL(baseUrl);
    this.pathname = this.urlObj.pathname;
    
    // Character sets for different fuzzing modes
    this.charsets = {
      'lower': 'abcdefghijklmnopqrstuvwxyz',
      'upper': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      'digit': '0123456789',
      'hex': '0123456789abcdef',
      'hex_upper': '0123456789ABCDEF',
      'special': '-_',
      'all': 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'
    };
  }

  // Find hash-like tokens in URL (hex strings, base64-like strings)
  findTokens() {
    const tokens = [];
    
    // MD5/SHA patterns
    const hexPattern = /[a-f0-9]{20,}/gi;
    let match;
    while ((match = hexPattern.exec(this.pathname)) !== null) {
      tokens.push({
        value: match[0],
        index: match.index,
        type: 'hex',
        length: match[0].length
      });
    }
    
    // Base64-like tokens (alphanumeric + dash/underscore, 20+ chars)
    const base64Pattern = /[A-Za-z0-9_-]{20,}/g;
    while ((match = base64Pattern.exec(this.pathname)) !== null) {
      // Skip if already matched as hex
      if (!tokens.some(t => t.index === match.index)) {
        tokens.push({
          value: match[0],
          index: match.index,
          type: 'base64',
          length: match[0].length
        });
      }
    }
    
    return tokens;
  }

  // Hashcat-style mask fuzzing: replace random characters in token
  *maskFuzzer(token, mutations = 5) {
    const chars = token.split('');
    const charset = this.charsets.all;
    
    for (let mutationNum = 0; mutationNum < this.range; mutationNum++) {
      // Randomly select 1-3 character positions to replace
      const numMutations = Math.min(mutations, Math.max(1, Math.floor(Math.random() * 3) + 1));
      const positions = new Set();
      
      while (positions.size < numMutations) {
        positions.add(Math.floor(Math.random() * chars.length));
      }
      
      const mutated = [...chars];
      for (const pos of positions) {
        mutated[pos] = charset[Math.floor(Math.random() * charset.length)];
      }
      
      const newToken = mutated.join('');
      yield this.baseUrl.replace(token, newToken);
    }
  }

  // Targeted character replacement on hex strings
  *hexMutator(token) {
    const hexChars = this.charsets.hex;
    const chars = token.split('');
    
    for (let i = 0; i < this.range; i++) {
      const mutated = [...chars];
      // Replace 1-2 random hex digits
      for (let j = 0; j < Math.max(1, Math.floor(Math.random() * 2) + 1); j++) {
        const pos = Math.floor(Math.random() * chars.length);
        mutated[pos] = hexChars[Math.floor(Math.random() * hexChars.length)];
      }
      
      const newToken = mutated.join('');
      yield this.baseUrl.replace(token, newToken);
    }
  }

  // Dictionary-style fuzzing: replace whole token segments
  *dictionaryMutator(token) {
    const charset = this.charsets.all;
    const segmentSize = Math.floor(token.length / 3);
    
    for (let i = 0; i < this.range; i++) {
      let newToken = token;
      
      // Replace 1-2 segments
      const numSegments = Math.random() > 0.5 ? 1 : 2;
      for (let s = 0; s < numSegments; s++) {
        const startPos = Math.floor(Math.random() * (token.length - segmentSize));
        let replacement = '';
        for (let c = 0; c < segmentSize; c++) {
          replacement += charset[Math.floor(Math.random() * charset.length)];
        }
        newToken = newToken.substring(0, startPos) + replacement + newToken.substring(startPos + segmentSize);
      }
      
      yield this.baseUrl.replace(token, newToken);
    }
  }

  // Substitute similar-looking characters
  *substitutionMutator(token) {
    const substitutions = {
      '0': ['O'],
      'O': ['0'],
      '1': ['I', 'l'],
      'I': ['1', 'l'],
      'l': ['1', 'I'],
      'a': ['e'],
      'e': ['a'],
      'o': ['0'],
      's': ['5'],
      '5': ['s'],
      'b': ['8', 'd'],
      '8': ['b'],
      't': ['7']
    };
    
    for (let i = 0; i < this.range; i++) {
      const chars = token.split('');
      const pos = Math.floor(Math.random() * chars.length);
      const char = chars[pos];
      
      if (substitutions[char]) {
        const alternatives = substitutions[char];
        chars[pos] = alternatives[Math.floor(Math.random() * alternatives.length)];
        const newToken = chars.join('');
        yield this.baseUrl.replace(token, newToken);
      }
    }
  }

  // Main fuzzer: generate mutations across all tokens
  *generateAll() {
    const tokens = this.findTokens();
    console.log(`Found ${tokens.length} token(s) to fuzz: ${tokens.map(t => t.value.substring(0, 10) + '...').join(', ')}`);
    
    if (tokens.length === 0) return;
    
    // Cycle through different fuzzing strategies
    const strategies = [
      { gen: (t) => this.maskFuzzer(t, 3), name: 'mask' },
      { gen: (t) => this.hexMutator(t), name: 'hex' },
      { gen: (t) => this.dictionaryMutator(t), name: 'dict' },
      { gen: (t) => this.substitutionMutator(t), name: 'sub' }
    ];
    
    let generated = 0;
    let strategyIndex = 0;
    
    while (generated < this.range) {
      for (const token of tokens) {
        const strategy = strategies[strategyIndex % strategies.length];
        
        try {
          for (const url of strategy.gen(token.value)) {
            if (generated >= this.range) return;
            yield url;
            generated++;
          }
        } catch (e) {
          // Skip failed generations
        }
        
        strategyIndex++;
      }
    }
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
      const response = await axios.get(url, {
        timeout,
        maxRedirects: 3,
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
          contentType: 'cached',
          hash: null,
          isDuplicate: false
        };
      }
      
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
      
      // Must be actual image
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
      
      // Reject tiny files
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
      
      // Hash content for deduplication
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
        contentType,
        hash: contentHash,
        isDuplicate
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
  
  // Generate fuzzy mutations from reference URLs
  for (const baseUrl of referenceUrls) {
    const bruteForcer = new MaskBasedBruteForcer(baseUrl, range);
    
    console.log(`[${sessionKey}] Starting mask-based fuzzing on: ${baseUrl}`);
    
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
  
  console.log(`[${sessionKey}] Generated ${totalGenerated} fuzzy URL mutations`);
  
  // Process with concurrency
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
        
        // Store unique images
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
  
  console.log(`[${sessionKey}] Fuzzing complete. Found ${session.stats.new} unique new images`);
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
