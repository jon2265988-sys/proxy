/**
 * Cloudflare Workers Streaming Proxy - FIXED VERSION
 * Comprehensive fixes for header handling and anti-bot bypassing
 */

// Retry configuration for robust fetching - optimized for speed
const RETRY_CONFIG = {
  maxRetries: 2,
  initialDelay: 25,
  maxDelay: 300,
  backoffMultiplier: 2
};

const TIMEOUT_MS = 15000; // 15 second timeout for M3U8
const SEGMENT_TIMEOUT_MS = 10000; // 10 second timeout for segments

// Connection pool optimization with HTTP/2 and enhanced caching
const FETCH_OPTIONS = {
  cf: {
    cacheTtl: 3600,
    cacheEverything: true,
    minify: { javascript: false, css: false, html: false },
    mirage: false,
    polish: 'off',
    resolveOverride: null,
    cacheKey: null
  }
};

// Request deduplication map
const pendingRequests = new Map();

// More realistic User-Agent (matches common browsers)
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export default {
  async fetch(request, env) {
    request.startTime = Date.now();
    
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers for all responses
    const corsHeaders = {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type, Date, Server, X-Cache-Hit',
      'Access-Control-Max-Age': '86400',
      'Timing-Allow-Origin': '*'
    };

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Route requests
      if (path === '/health') {
        return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() }, corsHeaders);
      }

      if (path === '/m3u8-proxy') {
        return await handleM3U8Proxy(request, env, corsHeaders);
      }

      if (path === '/m3u8-proxy-no-referer') {
        return await handleM3U8ProxyNoReferer(request, env, corsHeaders);
      }

      if (path === '/ts-proxy') {
        return await handleSegmentProxy(request, env, corsHeaders);
      }

      if (path === '/mp4-proxy') {
        return await handleMP4Proxy(request, env, corsHeaders);
      }

      if (path === '/subtitle') {
        return await handleSubtitleProxy(request, env, corsHeaders);
      }

      if (path === '/fetch') {
        return await handleFetch(request, env, corsHeaders);
      }

      if (path === '/fetch-no-referer') {
        return await handleFetchNoReferer(request, env, corsHeaders);
      }

      // 404
      return jsonResponse({
        error: 'Not Found',
        availableEndpoints: [
          '/health',
          '/m3u8-proxy?url=<url>&headers=<json_headers>',
          '/m3u8-proxy-no-referer?url=<url>&headers=<json_headers>',
          '/ts-proxy?url=<url>&headers=<json_headers>',
          '/mp4-proxy?url=<url>&headers=<json_headers>',
          '/fetch?url=<url>&headers=<json_headers>',
          '/fetch-no-referer?url=<url>&headers=<json_headers>',
          '/subtitle?url=<subtitle_url>&headers=<json_headers>'
        ]
      }, corsHeaders, 404);

    } catch (error) {
      console.error('Worker error:', error);
      return jsonResponse({
        error: 'Internal Server Error',
        message: error.message
      }, corsHeaders, 500);
    }
  }
};

/**
 * Retry wrapper with exponential backoff, timeout protection, and request deduplication
 */
async function fetchWithRetry(url, options, retries = RETRY_CONFIG.maxRetries, timeoutMs = TIMEOUT_MS) {
  const requestKey = `${url}:${JSON.stringify(options?.headers || {})}`;
  if (pendingRequests.has(requestKey)) {
    try {
      return await pendingRequests.get(requestKey);
    } catch (error) {
      // If the pending request failed, continue to try again
    }
  }

  let lastError;
  let delay = RETRY_CONFIG.initialDelay;

  const fetchPromise = (async () => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
          ...FETCH_OPTIONS
        });

        clearTimeout(timeoutId);

        // Only retry on specific status codes (5xx and 429)
        if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) {
          pendingRequests.delete(requestKey);
          return response;
        }

        lastError = new Error(`HTTP ${response.status}: ${response.statusText}`);
        console.warn(`⚠️ Attempt ${attempt + 1} failed: ${lastError.message}`);

      } catch (error) {
        lastError = error;
        console.warn(`⚠️ Attempt ${attempt + 1} failed: ${error.message}`);
        
        if (attempt === retries || error.name === 'AbortError') {
          break;
        }
      }

      // Wait before retrying (exponential backoff)
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, Math.min(delay, RETRY_CONFIG.maxDelay)));
        delay *= RETRY_CONFIG.backoffMultiplier;
      }
    }

    pendingRequests.delete(requestKey);
    throw lastError;
  })();

  pendingRequests.set(requestKey, fetchPromise);
  return fetchPromise;
}

/**
 * Safe cache operations with error handling
 */
async function safeCacheGet(cache, cacheKey) {
  try {
    return await cache.match(cacheKey);
  } catch (error) {
    console.warn('Cache read error:', error.message);
    return null;
  }
}

async function safeCachePut(cache, cacheKey, response) {
  try {
    await cache.put(cacheKey, response);
  } catch (error) {
    console.warn('Cache write error:', error.message);
  }
}

/**
 * Validate URL before proxying to prevent SSRF attacks
 */
function validateUrl(urlString) {
  try {
    const url = new URL(urlString);
    
    if (!['http:', 'https:'].includes(url.protocol)) {
      return { valid: false, error: 'Only HTTP/HTTPS protocols allowed' };
    }

    const hostname = url.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname.startsWith('127.') ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('172.16.') ||
      hostname.startsWith('169.254.') ||
      hostname === '[::1]'
    ) {
      return { valid: false, error: 'Private IPs not allowed' };
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * FIXED: Parse custom headers from query parameters with proper error handling
 */
function parseCustomHeaders(url) {
  const customHeaders = {};
  
  const headersParam = url.searchParams.get('headers');
  if (headersParam) {
    try {
      let headersObj;
      try {
        headersObj = JSON.parse(headersParam);
      } catch {
        // Try base64 decode
        const decoded = atob(headersParam);
        headersObj = JSON.parse(decoded);
      }
      
      // Properly merge headers (case-sensitive)
      Object.assign(customHeaders, headersObj);
      console.log('✓ Parsed custom headers:', Object.keys(headersObj));
    } catch (error) {
      console.warn('✗ Failed to parse headers:', error.message);
    }
  }

  // Parse individual header_* parameters
  for (const [key, value] of url.searchParams.entries()) {
    if (key.startsWith('header_')) {
      const headerName = key.replace('header_', '').replace(/_/g, '-');
      customHeaders[headerName] = value;
    }
  }

  return customHeaders;
}

/**
 * FIXED: Build request headers with better bot detection avoidance
 */
function buildRequestHeaders(customHeaders = {}, includeReferer = true) {
  const headers = {
    'User-Agent': DEFAULT_USER_AGENT,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
    ...customHeaders
  };

  // If no-referer mode, remove any referer headers
  if (!includeReferer) {
    delete headers['Referer'];
    delete headers['referer'];
  }

  return headers;
}

/**
 * Handle M3U8 playlist proxying with URL rewriting
 */
async function handleM3U8Proxy(request, env, corsHeaders) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return jsonResponse({ error: 'Missing url parameter' }, corsHeaders, 400);
  }

  const urlValidation = validateUrl(targetUrl);
  if (!urlValidation.valid) {
    return jsonResponse({ error: urlValidation.error }, corsHeaders, 400);
  }

  if (env.ENABLE_TURNSTILE === 'true') {
    try {
      const turnstileValid = await verifyTurnstile(request, env);
      if (!turnstileValid) {
        return jsonResponse({ error: 'Turnstile verification failed' }, corsHeaders, 403);
      }
    } catch (error) {
      console.error('Turnstile verification error:', error);
      return jsonResponse({ error: 'Verification service unavailable' }, corsHeaders, 503);
    }
  }

  const cache = caches.default;
  const cacheKey = new Request(request.url, request);
  const cachedResponse = await safeCacheGet(cache, cacheKey);
  if (cachedResponse) {
    return new Response(cachedResponse.body, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/vnd.apple.mpegurl',
        'X-Cache-Hit': 'true'
      }
    });
  }

  // FIXED: Parse custom headers properly
  const customHeaders = parseCustomHeaders(url);

  try {
    // FIXED: Use buildRequestHeaders for consistent header handling
    const requestHeaders = buildRequestHeaders(customHeaders, true);

    const m3u8Response = await fetchWithRetry(targetUrl, {
      headers: requestHeaders
    });

    if (!m3u8Response.ok) {
      return jsonResponse({
        error: 'Failed to fetch M3U8',
        status: m3u8Response.status,
        statusText: m3u8Response.statusText
      }, corsHeaders, m3u8Response.status);
    }

    const m3u8Content = await m3u8Response.text();
    if (!m3u8Content.trim().startsWith('#EXTM3U')) {
      return jsonResponse({
        error: 'Invalid M3U8 content',
        message: 'Response does not appear to be a valid M3U8 playlist'
      }, corsHeaders, 422);
    }

    function robustParseUrl(reqUrl, baseUrl) {
      try {
        if (!reqUrl) return null;
        if (/^https?:\/\//i.test(reqUrl)) return reqUrl;
        return new URL(reqUrl, baseUrl).href;
      } catch {
        return null;
      }
    }

    const workerUrl = new URL(request.url).origin;
    const headersParam = url.searchParams.get('headers') ? `&headers=${encodeURIComponent(url.searchParams.get('headers'))}` : '';
    const baseUrl = targetUrl;

    const isMaster = m3u8Content.includes('RESOLUTION=') || m3u8Content.includes('#EXT-X-STREAM-INF');
    const lines = m3u8Content.split('\n');
    const newLines = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) {
        // Proxy #EXT-X-KEY
        if (trimmed.startsWith('#EXT-X-KEY:')) {
          const keyUrlMatch = line.match(/URI="([^"]+)"/);
          if (keyUrlMatch) {
            const keyUrl = robustParseUrl(keyUrlMatch[1], baseUrl);
            if (keyUrl) {
              const proxyKeyUrl = `${workerUrl}/ts-proxy?url=${encodeURIComponent(keyUrl)}${headersParam}`;
              newLines.push(line.replace(keyUrlMatch[1], proxyKeyUrl));
              continue;
            }
          }
        }
        // Proxy #EXT-X-MAP
        if (trimmed.startsWith('#EXT-X-MAP:')) {
          const mapUrlMatch = line.match(/URI="([^"]+)"/);
          if (mapUrlMatch) {
            const mapUrl = robustParseUrl(mapUrlMatch[1], baseUrl);
            if (mapUrl) {
              const proxyMapUrl = `${workerUrl}/ts-proxy?url=${encodeURIComponent(mapUrl)}${headersParam}`;
              newLines.push(line.replace(mapUrlMatch[1], proxyMapUrl));
              continue;
            }
          }
        }
        // Proxy #EXT-X-MEDIA
        if (trimmed.startsWith('#EXT-X-MEDIA:')) {
          const mediaUrlMatch = line.match(/URI="([^"]+)"/);
          if (mediaUrlMatch) {
            const mediaUrl = robustParseUrl(mediaUrlMatch[1], baseUrl);
            if (mediaUrl) {
              const proxyMediaUrl = `${workerUrl}/m3u8-proxy?url=${encodeURIComponent(mediaUrl)}${headersParam}`;
              newLines.push(line.replace(mediaUrlMatch[1], proxyMediaUrl));
              continue;
            }
          }
        }
        newLines.push(line);
        continue;
      }
      // Master playlist: variant URLs
      if (isMaster && trimmed && !trimmed.startsWith('#')) {
        const variantUrl = robustParseUrl(trimmed, baseUrl);
        if (variantUrl) {
          newLines.push(`${workerUrl}/m3u8-proxy?url=${encodeURIComponent(variantUrl)}${headersParam}`);
        } else {
          newLines.push(line);
        }
        continue;
      }
      // Media playlist: segment URLs
      if (!isMaster && trimmed && !trimmed.startsWith('#')) {
        const segmentUrl = robustParseUrl(trimmed, baseUrl);
        if (segmentUrl) {
          newLines.push(`${workerUrl}/ts-proxy?url=${encodeURIComponent(segmentUrl)}${headersParam}`);
        } else {
          newLines.push(line);
        }
        continue;
      }
      newLines.push(line);
    }

    const responseHeaders = {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    };

    const rewrittenContent = newLines.join('\n');
    const finalResponse = new Response(rewrittenContent, { headers: responseHeaders });
    if (m3u8Response.status !== 206) {
      await safeCachePut(cache, cacheKey, finalResponse.clone());
    }
    return finalResponse;
  } catch (error) {
    return jsonResponse({
      error: 'Proxy error',
      message: error.message,
      type: error.name
    }, corsHeaders, 502);
  }
}

/**
 * Handle M3U8 proxy without referer
 */
async function handleM3U8ProxyNoReferer(request, env, corsHeaders) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return jsonResponse({ error: 'Missing url parameter' }, corsHeaders, 400);
  }

  const urlValidation = validateUrl(targetUrl);
  if (!urlValidation.valid) {
    return jsonResponse({ error: urlValidation.error }, corsHeaders, 400);
  }

  if (env.ENABLE_TURNSTILE === 'true') {
    try {
      const turnstileValid = await verifyTurnstile(request, env);
      if (!turnstileValid) {
        return jsonResponse({ error: 'Turnstile verification failed' }, corsHeaders, 403);
      }
    } catch (error) {
      console.error('Turnstile verification error:', error);
      return jsonResponse({ error: 'Verification service unavailable' }, corsHeaders, 503);
    }
  }

  const cache = caches.default;
  const cacheKey = new Request(request.url, request);
  const cachedResponse = await safeCacheGet(cache, cacheKey);
  if (cachedResponse) {
    return new Response(cachedResponse.body, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/vnd.apple.mpegurl',
        'X-Cache-Hit': 'true'
      }
    });
  }

  // FIXED: Parse custom headers and explicitly remove referer
  let customHeaders = parseCustomHeaders(url);
  delete customHeaders['Referer'];
  delete customHeaders['referer'];

  try {
    // FIXED: Use buildRequestHeaders with includeReferer=false
    const requestHeaders = buildRequestHeaders(customHeaders, false);

    const m3u8Response = await fetchWithRetry(targetUrl, {
      headers: requestHeaders
    });

    if (!m3u8Response.ok) {
      return jsonResponse({
        error: 'Failed to fetch M3U8',
        status: m3u8Response.status,
        statusText: m3u8Response.statusText
      }, corsHeaders, m3u8Response.status);
    }

    const m3u8Content = await m3u8Response.text();
    if (!m3u8Content.trim().startsWith('#EXTM3U')) {
      return jsonResponse({
        error: 'Invalid M3U8 content',
        message: 'Response does not appear to be a valid M3U8 playlist'
      }, corsHeaders, 422);
    }

    function robustParseUrl(reqUrl, baseUrl) {
      try {
        if (!reqUrl) return null;
        if (/^https?:\/\//i.test(reqUrl)) return reqUrl;
        return new URL(reqUrl, baseUrl).href;
      } catch {
        return null;
      }
    }

    const workerUrl = new URL(request.url).origin;
    const headersParam = url.searchParams.get('headers') ? `&headers=${encodeURIComponent(url.searchParams.get('headers'))}` : '';
    const baseUrl = targetUrl;

    const isMaster = m3u8Content.includes('RESOLUTION=') || m3u8Content.includes('#EXT-X-STREAM-INF');
    const lines = m3u8Content.split('\n');
    const newLines = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) {
        if (trimmed.startsWith('#EXT-X-KEY:')) {
          const keyUrlMatch = line.match(/URI="([^"]+)"/);
          if (keyUrlMatch) {
            const keyUrl = robustParseUrl(keyUrlMatch[1], baseUrl);
            if (keyUrl) {
              const proxyKeyUrl = `${workerUrl}/ts-proxy?url=${encodeURIComponent(keyUrl)}${headersParam}`;
              newLines.push(line.replace(keyUrlMatch[1], proxyKeyUrl));
              continue;
            }
          }
        }
        if (trimmed.startsWith('#EXT-X-MAP:')) {
          const mapUrlMatch = line.match(/URI="([^"]+)"/);
          if (mapUrlMatch) {
            const mapUrl = robustParseUrl(mapUrlMatch[1], baseUrl);
            if (mapUrl) {
              const proxyMapUrl = `${workerUrl}/ts-proxy?url=${encodeURIComponent(mapUrl)}${headersParam}`;
              newLines.push(line.replace(mapUrlMatch[1], proxyMapUrl));
              continue;
            }
          }
        }
        if (trimmed.startsWith('#EXT-X-MEDIA:')) {
          const mediaUrlMatch = line.match(/URI="([^"]+)"/);
          if (mediaUrlMatch) {
            const mediaUrl = robustParseUrl(mediaUrlMatch[1], baseUrl);
            if (mediaUrl) {
              const proxyMediaUrl = `${workerUrl}/m3u8-proxy-no-referer?url=${encodeURIComponent(mediaUrl)}${headersParam}`;
              newLines.push(line.replace(mediaUrlMatch[1], proxyMediaUrl));
              continue;
            }
          }
        }
        newLines.push(line);
        continue;
      }
      if (isMaster && trimmed && !trimmed.startsWith('#')) {
        const variantUrl = robustParseUrl(trimmed, baseUrl);
        if (variantUrl) {
          newLines.push(`${workerUrl}/m3u8-proxy-no-referer?url=${encodeURIComponent(variantUrl)}${headersParam}`);
        } else {
          newLines.push(line);
        }
        continue;
      }
      if (!isMaster && trimmed && !trimmed.startsWith('#')) {
        const segmentUrl = robustParseUrl(trimmed, baseUrl);
        if (segmentUrl) {
          newLines.push(`${workerUrl}/ts-proxy?url=${encodeURIComponent(segmentUrl)}${headersParam}`);
        } else {
          newLines.push(line);
        }
        continue;
      }
      newLines.push(line);
    }

    const responseHeaders = {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    };

    const rewrittenContent = newLines.join('\n');
    const finalResponse = new Response(rewrittenContent, { headers: responseHeaders });
    if (m3u8Response.status !== 206) {
      await safeCachePut(cache, cacheKey, finalResponse.clone());
    }
    return finalResponse;
  } catch (error) {
    return jsonResponse({
      error: 'Proxy error',
      message: error.message,
      type: error.name
    }, corsHeaders, 502);
  }
}

/**
 * FIXED: Handle TS/segment proxying with proper header handling
 */
async function handleSegmentProxy(request, env, corsHeaders) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  
  if (!targetUrl) {
    return jsonResponse({ error: 'Missing url parameter' }, corsHeaders, 400);
  }

  const urlValidation = validateUrl(targetUrl);
  if (!urlValidation.valid) {
    return jsonResponse({ error: urlValidation.error }, corsHeaders, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(request.url, request);
  const cachedResponse = await safeCacheGet(cache, cacheKey);

  if (cachedResponse) {
    let contentType = cachedResponse.headers.get('content-type');
    if (!contentType) {
      contentType = 'video/mp2t';
    }
    return new Response(cachedResponse.body, {
      headers: {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*',
        'Cache-Control': 'public, max-age=3600'
      }
    });
  }

  // FIXED: Parse custom headers properly
  const customHeaders = parseCustomHeaders(url);

  // FIXED: Use buildRequestHeaders for consistent header handling
  const requestHeaders = buildRequestHeaders(customHeaders, true);

  // Forward Range header if present
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    requestHeaders['Range'] = rangeHeader;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SEGMENT_TIMEOUT_MS);

    const segmentResponse = await fetch(targetUrl, {
      headers: requestHeaders,
      signal: controller.signal,
      cf: {
        cacheTtl: 3600,
        cacheEverything: true
      }
    });

    clearTimeout(timeoutId);

    if (!segmentResponse.ok) {
      return jsonResponse({
        error: 'Failed to fetch segment',
        status: segmentResponse.status
      }, corsHeaders, segmentResponse.status);
    }

    const contentType = segmentResponse.headers.get('content-type') || 'video/mp2t';

    // Check if response is M3U8 (nested playlists)
    const responseClone = segmentResponse.clone();
    let isM3U8Content = false;
    
    try {
      const reader = responseClone.body.getReader();
      const { value } = await reader.read();
      reader.releaseLock();
      
      if (value) {
        const text = new TextDecoder().decode(value.slice(0, 1024));
        isM3U8Content = text.trim().startsWith('#EXTM3U');
      }
    } catch (e) {
      isM3U8Content = contentType.includes('mpegurl') || 
                      contentType.includes('m3u8') || 
                      contentType.includes('application/vnd.apple');
    }

    if (isM3U8Content) {
      const content = await segmentResponse.text();
      if (content.trim().startsWith('#EXTM3U')) {
        const baseUrl = new URL(targetUrl);
        const workerUrl = new URL(request.url).origin;
        const headersParam = url.searchParams.get('headers') 
          ? `&headers=${encodeURIComponent(url.searchParams.get('headers'))}` 
          : '';

        const lines = content.split('\n');
        const rewrittenLines = lines.map(line => {
          const trimmedLine = line.trim();
          if (trimmedLine.startsWith('#')) {
            const uriMatch = line.match(/URI="([^"]+)"/);
            if (uriMatch) {
              try {
                const originalUri = uriMatch[1];
                let resolvedUrl;
                if (originalUri.startsWith('http://') || originalUri.startsWith('https://')) {
                  resolvedUrl = originalUri;
                } else {
                  resolvedUrl = new URL(originalUri, baseUrl.href).href;
                }
                let proxyUrl;
                if (resolvedUrl.includes('.m3u8') || resolvedUrl.includes('type=video') || resolvedUrl.includes('type=audio') || resolvedUrl.includes('type=subtitle') || resolvedUrl.includes('/playlist/')) {
                  proxyUrl = `${workerUrl}/m3u8-proxy?url=${encodeURIComponent(resolvedUrl)}${headersParam}`;
                } else {
                  proxyUrl = `${workerUrl}/ts-proxy?url=${encodeURIComponent(resolvedUrl)}${headersParam}`;
                }
                return line.replace(/URI="[^"]+"/, `URI="${proxyUrl}"`);
              } catch (error) {
                return line;
              }
            }
            return line;
          }
          if (!trimmedLine) {
            return line;
          }
          try {
            let resolvedUrl;
            if (trimmedLine.startsWith('http://') || trimmedLine.startsWith('https://')) {
              resolvedUrl = trimmedLine;
            } else if (trimmedLine.length > 0) {
              resolvedUrl = new URL(trimmedLine, baseUrl.href).href;
            } else {
              return line;
            }
            if (resolvedUrl.includes('.m3u8') || resolvedUrl.includes('type=video') || resolvedUrl.includes('type=audio') || resolvedUrl.includes('type=subtitle') || resolvedUrl.includes('/playlist/')) {
              return `${workerUrl}/m3u8-proxy?url=${encodeURIComponent(resolvedUrl)}${headersParam}`;
            } else {
              return `${workerUrl}/ts-proxy?url=${encodeURIComponent(resolvedUrl)}${headersParam}`;
            }
          } catch (error) {
            return line;
          }
        });
        const rewrittenContent = rewrittenLines.join('\n');
        const finalResponse = new Response(rewrittenContent, {
          status: segmentResponse.status,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'public, max-age=3, must-revalidate',
            'X-Cache-Hit': 'false'
          }
        });
        if (segmentResponse.status !== 206) {
          safeCachePut(cache, cacheKey, finalResponse.clone()).catch(() => {});
        }
        return finalResponse;
      }
    }

    // Binary segment - stream immediately
    const finalResponse = new Response(segmentResponse.body, {
      status: segmentResponse.status,
      headers: {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': '*',
        'Cache-Control': 'public, max-age=3600',
        'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff',
        'Timing-Allow-Origin': '*'
      }
    });

    if (segmentResponse.headers.get('content-length')) {
      finalResponse.headers.set('Content-Length', segmentResponse.headers.get('content-length'));
    }
    if (segmentResponse.headers.get('content-range')) {
      finalResponse.headers.set('Content-Range', segmentResponse.headers.get('content-range'));
    }

    if (segmentResponse.status !== 206) {
      safeCachePut(cache, cacheKey, finalResponse.clone()).catch(() => {});
    }

    return finalResponse;

  } catch (error) {
    if (error.name === 'AbortError') {
      return jsonResponse({
        error: 'Segment fetch timeout',
        message: 'Origin server too slow'
      }, corsHeaders, 504);
    }
    
    return jsonResponse({
      error: 'Proxy error',
      message: error.message,
      type: error.name
    }, corsHeaders, 502);
  }
}

/**
 * FIXED: Handle MP4 proxying with proper headers
 */
async function handleMP4Proxy(request, env, corsHeaders) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  
  if (!targetUrl) {
    return jsonResponse({ error: 'Missing url parameter' }, corsHeaders, 400);
  }

  const urlValidation = validateUrl(targetUrl);
  if (!urlValidation.valid) {
    return jsonResponse({ error: urlValidation.error }, corsHeaders, 400);
  }

  if (env.ENABLE_TURNSTILE === 'true') {
    try {
      const turnstileValid = await verifyTurnstile(request, env);
      if (!turnstileValid) {
        return jsonResponse({ error: 'Turnstile verification failed' }, corsHeaders, 403);
      }
    } catch (error) {
      console.error('Turnstile verification error:', error);
    }
  }

  console.log('🎬 MP4 Request');

  // FIXED: Parse custom headers properly
  const customHeaders = parseCustomHeaders(url);

  // FIXED: Use buildRequestHeaders for consistent header handling
  const requestHeaders = buildRequestHeaders(customHeaders, true);

  // Forward Range header for seeking support
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    requestHeaders['Range'] = rangeHeader;
  }

  try {
    const mp4Response = await fetchWithRetry(targetUrl, {
      headers: requestHeaders
    }, RETRY_CONFIG.maxRetries, SEGMENT_TIMEOUT_MS);

    if (!mp4Response.ok) {
      console.error('❌ MP4 fetch failed:', mp4Response.status);
      return jsonResponse({
        error: 'Failed to fetch MP4',
        status: mp4Response.status
      }, corsHeaders, mp4Response.status);
    }

    const responseHeaders = new Headers({
      ...corsHeaders,
      'Content-Type': mp4Response.headers.get('content-type') || 'video/mp4',
      'Accept-Ranges': 'bytes'
    });

    if (mp4Response.headers.has('content-length')) {
      responseHeaders.set('Content-Length', mp4Response.headers.get('content-length'));
    }
    if (mp4Response.headers.has('content-range')) {
      responseHeaders.set('Content-Range', mp4Response.headers.get('content-range'));
    }

    const passthroughHeaders = [
      'cache-control', 'last-modified', 'etag', 'expires', 'x-content-type-options', 'date', 'server'
    ];
    for (const [key, value] of mp4Response.headers.entries()) {
      if (!responseHeaders.has(key) && passthroughHeaders.includes(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    }

    return new Response(mp4Response.body, {
      status: mp4Response.status,
      statusText: mp4Response.statusText,
      headers: responseHeaders
    });

  } catch (error) {
    console.error('❌ MP4 proxy error:', error);
    return jsonResponse({
      error: 'Proxy error',
      message: error.message,
      type: error.name
    }, corsHeaders, 502);
  }
}

/**
 * FIXED: Handle generic fetch with proper headers
 */
async function handleFetch(request, env, corsHeaders) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  
  if (!targetUrl) {
    return jsonResponse({ error: 'Missing url parameter' }, corsHeaders, 400);
  }

  const urlValidation = validateUrl(targetUrl);
  if (!urlValidation.valid) {
    return jsonResponse({ error: urlValidation.error }, corsHeaders, 400);
  }

  if (env.ENABLE_TURNSTILE === 'true') {
    try {
      const turnstileValid = await verifyTurnstile(request, env);
      if (!turnstileValid) {
        return jsonResponse({ error: 'Turnstile verification failed' }, corsHeaders, 403);
      }
    } catch (error) {
      console.error('Turnstile verification error:', error);
    }
  }

  console.log('🌐 Fetch Request');

  // FIXED: Parse custom headers properly
  const customHeaders = parseCustomHeaders(url);

  // FIXED: Use buildRequestHeaders for consistent header handling
  const requestHeaders = buildRequestHeaders(customHeaders, true);

  // Forward Range header if present
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    requestHeaders['Range'] = rangeHeader;
  }

  try {
    const targetResponse = await fetchWithRetry(targetUrl, {
      method: request.method,
      headers: requestHeaders
    });

    if (!targetResponse.ok) {
      console.error('❌ Fetch failed:', targetResponse.status);
      return jsonResponse({
        error: 'Failed to fetch resource',
        status: targetResponse.status
      }, corsHeaders, targetResponse.status);
    }

    const contentType = targetResponse.headers.get('content-type') || 'application/octet-stream';
    console.log('✅ Fetched:', contentType);

    const responseHeaders = new Headers({
      ...corsHeaders,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'X-Upstream-Status': String(targetResponse.status)
    });

    // Forward all headers from the proxied response except forbidden ones
    for (const [key, value] of targetResponse.headers.entries()) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey === 'content-type' ||
        lowerKey === 'access-control-allow-origin' ||
        lowerKey === 'access-control-allow-headers' ||
        lowerKey === 'access-control-allow-methods' ||
        lowerKey === 'x-upstream-status'
      ) {
        continue;
      }
      responseHeaders.set(key, value);
    }

    return new Response(targetResponse.body, {
      status: targetResponse.status,
      statusText: targetResponse.statusText,
      headers: responseHeaders
    });

  } catch (error) {
    console.error('❌ Fetch proxy error:', error);
    return jsonResponse({
      error: 'Proxy error',
      message: error.message,
      type: error.name
    }, corsHeaders, 502);
  }
}

/**
 * FIXED: Handle fetch with NO REFERER
 */
async function handleFetchNoReferer(request, env, corsHeaders) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  
  if (!targetUrl) {
    return jsonResponse({ error: 'Missing url parameter' }, corsHeaders, 400);
  }

  const urlValidation = validateUrl(targetUrl);
  if (!urlValidation.valid) {
    return jsonResponse({ error: urlValidation.error }, corsHeaders, 400);
  }

  if (env.ENABLE_TURNSTILE === 'true') {
    try {
      const turnstileValid = await verifyTurnstile(request, env);
      if (!turnstileValid) {
        return jsonResponse({ error: 'Turnstile verification failed' }, corsHeaders, 403);
      }
    } catch (error) {
      console.error('Turnstile verification error:', error);
    }
  }

  console.log('🌐 Fetch Request (No Referer)');

  // FIXED: Parse custom headers and explicitly remove referer
  let customHeaders = parseCustomHeaders(url);
  delete customHeaders['Referer'];
  delete customHeaders['referer'];

  // FIXED: Use buildRequestHeaders with includeReferer=false
  const requestHeaders = buildRequestHeaders(customHeaders, false);

  // Forward Range header if present
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    requestHeaders['Range'] = rangeHeader;
  }

  try {
    const targetResponse = await fetchWithRetry(targetUrl, {
      method: request.method,
      headers: requestHeaders
    });

    if (!targetResponse.ok) {
      console.error('❌ Fetch failed:', targetResponse.status);
      return jsonResponse({
        error: 'Failed to fetch resource',
        status: targetResponse.status
      }, corsHeaders, targetResponse.status);
    }

    const contentType = targetResponse.headers.get('content-type') || 'application/octet-stream';
    console.log('✅ Fetched (No Referer):', contentType);

    const responseHeaders = new Headers({
      ...corsHeaders,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'X-Upstream-Status': String(targetResponse.status)
    });

    for (const [key, value] of targetResponse.headers.entries()) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey === 'content-type' ||
        lowerKey === 'access-control-allow-origin' ||
        lowerKey === 'access-control-allow-headers' ||
        lowerKey === 'access-control-allow-methods' ||
        lowerKey === 'x-upstream-status'
      ) {
        continue;
      }
      responseHeaders.set(key, value);
    }

    return new Response(targetResponse.body, {
      status: targetResponse.status,
      statusText: targetResponse.statusText,
      headers: responseHeaders
    });

  } catch (error) {
    console.error('❌ Fetch proxy error (No Referer):', error);
    return jsonResponse({
      error: 'Proxy error',
      message: error.message,
      type: error.name
    }, corsHeaders, 502);
  }
}

/**
 * FIXED: Handle subtitle proxy with proper headers
 */
async function handleSubtitleProxy(request, env, corsHeaders) {
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return jsonResponse({ error: 'Missing url parameter' }, corsHeaders, 400);
  }

  const urlValidation = validateUrl(targetUrl);
  if (!urlValidation.valid) {
    return jsonResponse({ error: urlValidation.error }, corsHeaders, 400);
  }

  try {
    // FIXED: Parse custom headers and use them
    const customHeaders = parseCustomHeaders(url);
    const requestHeaders = buildRequestHeaders(customHeaders, true);

    // Fetch subtitle with headers
    const response = await fetchWithRetry(targetUrl, {
      headers: requestHeaders
    }, 1, 15000);

    if (!response.ok) {
      return jsonResponse({ error: 'Failed to fetch subtitle', status: response.status }, corsHeaders, 502);
    }

    const buffer = await response.arrayBuffer();
    
    // Try to decode as UTF-8, fallback to ISO-8859-1 if it looks wrong
    let text = '';
    try {
      text = new TextDecoder('utf-8').decode(buffer);
      if ((text.match(/�/g) || []).length > 10) {
        text = new TextDecoder('iso-8859-1').decode(buffer);
      }
    } catch (e) {
      text = new TextDecoder('iso-8859-1').decode(buffer);
    }

    // Try to parse as SRT or VTT
    let entries = parseSRTorVTT(text);
    if (!entries || entries.length === 0) {
      return jsonResponse({ error: 'Unsupported subtitle format or failed to parse.' }, corsHeaders, 415);
    }

    // Convert to SRT
    const srt = entriesToSRT(entries);
    const utf8Srt = new TextEncoder().encode(srt);
    
    return new Response(utf8Srt, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/plain; charset=utf-8'
      }
    });
  } catch (err) {
    return jsonResponse({ error: 'Failed to fetch or convert subtitle', message: err.message }, corsHeaders, 500);
  }
}

// Minimal SRT/VTT parser for Workers
function parseSRTorVTT(text) {
  text = text.replace(/^\uFEFF/, '').replace(/\r\n|\r/g, '\n');
  text = text.replace(/^WEBVTT.*?\n+/, '');
  const blocks = text.split(/\n{2,}/);
  const entries = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    if (lines.length < 2) continue;
    let idx = 0;
    if (/^\d+$/.test(lines[0])) idx = 1;
    const timeMatch = lines[idx].match(/(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/);
    if (!timeMatch) continue;
    const start = timeMatch[1].replace(',', '.');
    const end = timeMatch[2].replace(',', '.');
    const textLines = lines.slice(idx + 1).join('\n');
    entries.push({ start, end, text: textLines });
  }
  return entries;
}

// Convert parsed entries to SRT format
function entriesToSRT(entries) {
  return entries.map((e, i) => `${i + 1}\n${e.start.replace('.', ',')} --> ${e.end.replace('.', ',')}\n${e.text}\n`).join('\n');
}

/**
 * Verify Cloudflare Turnstile token
 */
async function verifyTurnstile(request, env) {
  const url = new URL(request.url);
  const token = request.headers.get('cf-turnstile-token') || 
                url.searchParams.get('token');

  if (!token) {
    return false;
  }

  const formData = new FormData();
  formData.append('secret', env.TURNSTILE_SECRET_KEY);
  formData.append('response', token);
  formData.append('remoteip', request.headers.get('CF-Connecting-IP'));

  const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: formData
  });

  const outcome = await result.json();
  return outcome.success;
}

/**
 * Helper to create JSON responses
 */
function jsonResponse(data, corsHeaders, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}