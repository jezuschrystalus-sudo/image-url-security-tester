const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

const scanSessions = new Map();

// Ultimate Hashcat Brute Force - Independent dual-token enumeration
class UltimateHashcatBruteForcer {
  constructor(baseUrl, range) {
    this.baseUrl = baseUrl;
    this.range = range;
    this.urlObj = new URL(baseUrl);
    this.pathname = this.urlObj.pathname;
    
    // Hashcat character sets
    this.charsets = {
      'l': 'abcdefghijklmnopqrstuvwxyz',
      'u': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      'd': '0123456789',
      'h': '0123456789abcdef',
      'H': '0123456789ABCDEF',
      'a': 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      '?': 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'
    };
  }

  // Extract both tokens with their positions
  findTokens() {
    const tokens = [];
    
    // Find 64-char hex (first token)
    const hex64Pattern = /[a-f0-9]{64}/gi;
    let match = hex64Pattern.exec(this.pathname);
    if (match) {
      tokens.push({
        value: match[0],
        index: match.index,
        type: 'primary_hex',
        charset: 'h',
        length: 64,
        position: 0
      });
    }
    
    // Find 43-char base64-like (second token)
    const base64Pattern = /[A-Za-z0-9_-]{43}/g;
    match = base64Pattern.exec(this.pathname);
    if (match) {
      tokens.push({
        value: match[0],
        index: match.index,
        type: 'secondary_base64',
        charset: '?',
        length: 43,
        position: 1
      });
    }
    
    return tokens;
  }

  // Strategy 1: Fuzz PRIMARY token (64-char hex) with SECONDARY fixed
  *primaryTokenFuzzer() {
    const tokens = this.findTokens();
    if (tokens.length < 2) return;
    
    const primaryToken = tokens[0];
    const secondaryToken = tokens[1];
    const charset = this.charsets[primaryToken.charset];
    
    console.log(`[PRIMARY FUZZ] Enumerating ${primaryToken.value.substring(0, 10)}... (${primaryToken.length} chars)`);
    
    let generated = 0;
    const primaryRange = Math.floor(this.range / 2);
    
    // Enumerate last 8 characters of primary token
    const varZone = 8;
    const fixZone = primaryToken.length - varZone;
    const prefix = primaryToken.value.substring(0, fixZone);
    
    let positions = new Array(varZone).fill(0);
    let iterations = 0;
    
    while (iterations < primaryRange && generated < primaryRange) {
      // Build mutated primary
      let suffix = '';
      for (let i = 0; i < varZone; i++) {
        suffix += charset[positions[i] % charset.length];
      }
      
      const mutatedPrimary = prefix + suffix;
      
      // Keep secondary fixed
      const newUrl = this.baseUrl.replace(primaryToken.value, mutatedPrimary);
      
      if (newUrl !== this.baseUrl) {
        yield newUrl;
        generated++;
      }
      
      // Increment positions (odometer)
      let carry = 1;
      for (let i = varZone - 1; i >= 0 && carry; i--) {
        positions[i] += carry;
        if (positions[i] >= charset.length) {
          positions[i] = 0;
          carry = 1;
        } else {
          carry = 0;
        }
      }
      
      iterations++;
    }
  }

  // Strategy 2: Fuzz SECONDARY token (43-char base64) with PRIMARY fixed
  *secondaryTokenFuzzer() {
    const tokens = this.findTokens();
    if (tokens.length < 2) return;
    
    const primaryToken = tokens[0];
    const secondaryToken = tokens[1];
    const charset = this.charsets[secondaryToken.charset];
    
    console.log(`[SECONDARY FUZZ] Enumerating ${secondaryToken.value.substring(0, 10)}... (${secondaryToken.length} chars)`);
    
    let generated = 0;
    const secondaryRange = Math.floor(this.range / 2);
    
    // Enumerate last 10 characters of secondary token
    const varZone = 10;
    const fixZone = secondaryToken.length - varZone;
    const prefix = secondaryToken.value.substring(0, fixZone);
    
    let positions = new Array(varZone).fill(0);
    let iterations = 0;
    
    while (iterations < secondaryRange && generated < secondaryRange) {
      // Build mutated secondary
      let suffix = '';
      for (let i = 0; i < varZone; i++) {
        suffix += charset[positions[i] % charset.length];
      }
      
      const mutatedSecondary = prefix + suffix;
      
      // Keep primary fixed
      const newUrl = this.baseUrl.replace(secondaryToken.value, mutatedSecondary);
      
      if (newUrl !== this.baseUrl) {
        yield newUrl;
        generated++;
      }
      
      // Increment positions
      let carry = 1;
      for (let i = varZone - 1; i >= 0 && carry; i--) {
        positions[i] += carry;
        if (positions[i] >= charset.length) {
          positions[i] = 0;
          carry = 1;
        } else {
          carry = 0;
        }
      }
      
      iterations++;
    }
  }

  // Strategy 3: Dual token fuzzing - vary both simultaneously
  *dualTokenFuzzer() {
    const tokens = this.findTokens();
    if (tokens.length < 2) return;
    
    const primaryToken = tokens[0];
    const secondaryToken = tokens[1];
    const primaryCharset = this.charsets[primaryToken.charset];
    const secondaryCharset = this.charsets[secondaryToken.charset];
    
    console.log(`[DUAL FUZZ] Enumerating both tokens simultaneously`);
    
    const dualRange = Math.floor(this.range / 4);
    
    // Shorter variable zones for dual fuzzing
    const primaryVarZone = 6;
    const secondaryVarZone = 8;
    
    const primaryPrefix = primaryToken.value.substring(0, primaryToken.length - primaryVarZone);
    const secondaryPrefix = secondaryToken.value.substring(0, secondaryToken.length - secondaryVarZone);
    
    let primaryPos = new Array(primaryVarZone).fill(0);
    let secondaryPos = new Array(secondaryVarZone).fill(0);
    
    for (let iter = 0; iter < dualRange; iter++) {
      // Build mutated primary
      let primarySuffix = '';
      for (let i = 0; i < primaryVarZone; i++) {
        primarySuffix += primaryCharset[primaryPos[i] % primaryCharset.length];
      }
      const mutatedPrimary = primaryPrefix + primarySuffix;
      
      // Build mutated secondary
      let secondarySuffix = '';
      for (let i = 0; i < secondaryVarZone; i++) {
        secondarySuffix += secondaryCharset[secondaryPos[i] % secondaryCharset.length];
      }
      const mutatedSecondary = secondaryPrefix + secondarySuffix;
      
      // Replace both
      let newUrl = this.baseUrl.replace(primaryToken.value, mutatedPrimary);
      newUrl = newUrl.replace(secondaryToken.value, mutatedSecondary);
      
      if (newUrl !== this.baseUrl) {
        yield newUrl;
      }
      
      // Increment secondary (fast moving)
      let carry = 1;
      for (let i = secondaryVarZone - 1; i >= 0 && carry; i--) {
        secondaryPos[i] += carry;
        if (secondaryPos[i] >= secondaryCharset.length) {
          secondaryPos[i] = 0;
          carry = 1;
        } else {
          carry = 0;
        }
      }
      
      // Every N iterations, increment primary
      if (iter % 100 === 0) {
        carry = 1;
        for (let i = primaryVarZone - 1; i >= 0 && carry; i--) {
          primaryPos[i] += carry;
          if (primaryPos[i] >= primaryCharset.length) {
            primaryPos[i] = 0;
            carry = 1;
          } else {
            carry = 0;
          }
        }
      }
    }
  }

  // Main generator - all strategies
  *generateAll() {
    const tokens = this.findTokens();
    console.log(`Found ${tokens.length} tokens:`);
    tokens.forEach((t, i) => {
      console.log(`  [${i}] ${t.type}: ${t.value.substring(0, 16)}... (${t.length} chars, charset: ${t.charset})`);
    });
    
    if (tokens.length < 2) {
      console.log('ERROR: Need both primary and secondary tokens!');
      return;
    }
    
    // Execute all three strategies in sequence
    console.log('\n[STRATEGY 1] Fuzzing PRIMARY token...');
    yield* this.primaryTokenFuzzer();
    
    console.log('\n[STRATEGY 2] Fuzzing SECONDARY token...');
    yield* this.secondaryTokenFuzzer();
    
    console.log('\n[STRATEGY 3] Fuzzing BOTH tokens...');
    yield* this.dualTokenFuzzer();
  }
}

// Content-aware HTTP client with deduplication
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
      
      if (response.status === 304) {
        return { url, status: 304, found: false, contentLength: 0, hash: null, isDuplicate: false };
      }
      
      if (response.status !== 200) {
        return { url, status: response.status, found: false, contentLength: 0, hash: null, isDuplicate: false };
      }
      
      const contentLength = response.data.length;
      const contentType = response.headers['content-type'] || 'unknown';
      
      if (!contentType.includes('image/')) {
        return { url, status: 200, found: false, contentLength, hash: null, isDuplicate: false };
      }
      
      if (contentLength < 1500) {
        return { url, status: 200, found: false, contentLength, hash: null, isDuplicate: false };
      }
      
      const contentHash = crypto.createHash('md5').update(response.data).digest('hex');
      const isDuplicate = contentHashMap.has(contentHash);
      
      if (!isDuplicate) {
        contentHashMap.set(contentHash, url);
      }
      
      return { url, status: 200, found: true, contentLength, hash: contentHash, isDuplicate };
      
    } catch (error) {
      if (attempt === retries - 1) {
        return { url, status: 'timeout', found: false, contentLength: 0, hash: null, isDuplicate: false };
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
}

function classifyURL(data) {
  if (!data.found) return 'error';
  if (data.isDuplicate) return 'duplicate';
  if (data.contentLength < 3000) return 'placeholder';
  return 'new';
}

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

async function performBruteForceScan(referenceUrls, range, delay, concurrency, maxRequests, sessionKey) {
  const session = scanSessions.get(sessionKey);
  if (!session) return;
  
  let totalGenerated = 0;
  const urlQueue = [];
  const seenUrls = new Set(referenceUrls);
  const contentHashMap = new Map();
  
  // Generate URLs using ultimate fuzzer
  for (const baseUrl of referenceUrls) {
    const fuzzer = new UltimateHashcatBruteForcer(baseUrl, range);
    
    console.log(`\n[${sessionKey}] Starting ultimate brute force on: ${baseUrl}`);
    
    for (const url of fuzzer.generateAll()) {
      if (!seenUrls.has(url) && urlQueue.length < maxRequests) {
        urlQueue.push(url);
        seenUrls.add(url);
        totalGenerated++;
        
        if (totalGenerated >= maxRequests) break;
      }
    }
    
    if (totalGenerated >= maxRequests) break;
  }
  
  console.log(`\n[${sessionKey}] Generated ${totalGenerated} brute force URLs across all strategies`);
  
  // Process queue
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
  
  console.log(`\n[${sessionKey}] ✅ ULTIMATE BRUTE FORCE COMPLETE`);
  console.log(`Unique images found: ${session.stats.new + session.stats.placeholder}`);
  console.log(`Duplicates filtered: ${session.stats.duplicate}`);
  session.active = false;
}

app.get('/api/progress/:sessionId', (req, res) => {
  const session = scanSessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  
  res.json({
    active: session.active,
    stats: session.stats,
    results: session.results.slice(-50),
    totalResults: session.results.length
  });
});

app.post('/api/stop/:sessionId', (req, res) => {
  const session = scanSessions.get(req.params.sessionId);
  if (session) session.active = false;
  res.json({ success: true });
});

app.get('/api/export/:sessionId', (req, res) => {
  const session = scanSessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session.results);
});

app.listen(PORT, () => {
  console.log(`🔓 ULTIMATE IMAGE BRUTE FORCER (Hashcat Mode) running on http://localhost:${PORT}`);
});
