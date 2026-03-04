require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const API_BASE = 'https://redalert.orielhaim.com';
const API_TOKEN = `Bearer ${process.env.REDALERT_API_KEY}`;

if (!process.env.REDALERT_API_KEY) {
  console.error('Missing REDALERT_API_KEY environment variable');
  process.exit(1);
}

// --- City whitelist ---
const ALLOWED_CITIES = new Set([
  'תל אביב - יפו',
  'ירושלים',
  'חיפה',
  'באר שבע',
  'אשדוד',
  'אשקלון',
  'נתניה',
  'ראשון לציון',
  'פתח תקווה',
  'חולון',
  'בני ברק',
  'רמת גן',
  'הרצליה',
  'כפר סבא',
  'רעננה',
  'מודיעין-מכבים-רעות',
  'לוד',
  'רמלה',
  'בת ים',
  'גבעתיים',
  'קרית גת',
  'שדרות',
  'עפולה',
  'טבריה',
  'נהריה',
  'עכו',
  'קרית שמונה',
  'דימונה',
  'ערד',
  'אילת',
  'רהט',
  'נתיבות',
  'אופקים',
  'יבנה',
  'כרמיאל',
  'נצרת',
  'עראבה',
]);

// --- In-memory cache (15 min TTL, keyed by city name) ---
const cache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;

function getCached(city) {
  const entry = cache.get(city);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(city);
    return null;
  }
  return entry.data;
}

function setCache(city, data) {
  cache.set(city, { data, timestamp: Date.now() });
}

// --- Rate limiter (per IP) ---
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 20; // max requests per window
const rateLimitMap = new Map();

// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return false;
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return true;
  }
  return false;
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/alerts', async (req, res) => {
  // Rate limit check
  const ip = req.ip;
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }

  const city = req.query.city;
  if (!city) {
    return res.status(400).json({ error: 'city parameter is required' });
  }

  // Whitelist check
  if (!ALLOWED_CITIES.has(city)) {
    return res.status(403).json({ error: 'City not allowed', allowedCities: [...ALLOWED_CITIES] });
  }

  // Cache check
  const cached = getCached(city);
  if (cached) {
    return res.json(cached);
  }

  try {
    const allAlerts = [];
    let page = 1;
    const limit = 100;
    let totalPages = 1;

    // Get today's date boundaries in Israel timezone
    const now = new Date();
    const israelDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const todayStr = israelDate.toISOString().split('T')[0];

    while (page <= totalPages) {
      const url = `${API_BASE}/api/stats/history?search=${encodeURIComponent(city)}&limit=${limit}&page=${page}`;
      const response = await fetch(url, {
        headers: { 'Authorization': API_TOKEN }
      });

      if (!response.ok) {
        throw new Error(`API returned ${response.status}`);
      }

      const json = await response.json();
      totalPages = json.meta.totalPages;

      // Filter to today's missile alerts only (skip endAlert, newsFlash, etc.)
      for (const alert of json.data) {
        if (alert.type !== 'missiles') continue;

        const alertDate = new Date(alert.timestamp);
        const alertIsrael = new Date(alertDate.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
        const alertDateStr = alertIsrael.toISOString().split('T')[0];

        if (alertDateStr === todayStr) {
          allAlerts.push({
            id: alert.id,
            timestamp: alert.timestamp,
            type: alert.type,
            cities: alert.cities
          });
        } else if (alertDateStr < todayStr) {
          // Alerts are ordered by date desc, so we can stop paginating
          totalPages = 0;
          break;
        }
      }

      page++;
    }

    const result = { alerts: allAlerts, date: todayStr };
    setCache(city, result);
    res.json(result);
  } catch (err) {
    console.error('Error fetching alerts:', err.message);
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// Endpoint to get allowed cities (for frontend autocomplete/validation)
app.get('/api/cities', (req, res) => {
  res.json({ cities: [...ALLOWED_CITIES] });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
