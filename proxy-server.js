const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration from environment variables
const PROJECT_ID = process.env.PROJECT_ID || 'ca5f429d-c12e-457d-a17f-d3ba1aeb5044';
const MODEL_ID = 'ibm/granite-3-3-8b-instruct';
const WATSON_API_KEY = process.env.WATSON_API_KEY;

// Debug logging
console.log('=== ENVIRONMENT VARIABLES DEBUG ===');
console.log('WATSON_API_KEY exists:', !!WATSON_API_KEY);
console.log('WATSON_API_KEY length:', WATSON_API_KEY ? WATSON_API_KEY.length : 0);
console.log('WATSON_API_KEY first 10 chars:', WATSON_API_KEY ? WATSON_API_KEY.substring(0, 10) + '...' : 'undefined');
console.log('PROJECT_ID:', PROJECT_ID);
console.log('=====================================');

app.use(cors());
app.use(express.json({ limit: '200kb' }));

// Proxy endpoint for getting IAM token
app.post('/token', async (req, res) => {
  try {
    // Use API key from environment variable or request body
    const apiKey = WATSON_API_KEY || req.body.apiKey;
    
    console.log('=== TOKEN ENDPOINT DEBUG ===');
    console.log('WATSON_API_KEY from env:', !!WATSON_API_KEY);
    console.log('apiKey from request body:', !!req.body.apiKey);
    console.log('Final apiKey to use:', !!apiKey);
    console.log('apiKey length:', apiKey ? apiKey.length : 0);
    console.log('============================');
    
    const tokenRes = await fetch('https://iam.cloud.ibm.com/identity/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json'
      },
      body: `grant_type=urn:ibm:params:oauth:grant-type:apikey&apikey=${encodeURIComponent(apiKey)}`
    });

    if (!tokenRes.ok) {
      throw new Error(`IAM token request failed: ${tokenRes.status}`);
    }

    const tokenData = await tokenRes.json();
    res.json({ access_token: tokenData.access_token });
  } catch (error) {
    console.error('Token proxy error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper to normalize text into an array of strings
function normalizeToList(text) {
  if (!text) return [];
  let t = text.trim();
  // If it looks like a JSON array, try to parse
  if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('[') && t.includes(']'))) {
    try {
      // Replace single quotes with double quotes safely for JSON parsing
      const jsonLike = t
        .replace(/(^\s*\[\s*)'([^']*)'/g, '["$2"')
        .replace(/,'([^']*)'/g, ',"$1"')
        .replace(/'([^']*)'\s*\]/g, '"$1"]');
      const arr = JSON.parse(jsonLike);
      if (Array.isArray(arr)) {
        return arr.map(x => String(x).trim()).filter(x => x.length > 0);
      }
    } catch (e) {
      // fallthrough to line/CSV parsing
    }
  }
  // CSV-like: a, b, c
  if (t.includes(',') && !t.includes('\n')) {
    return t.split(',').map(s => s.trim()).map(s => s.replace(/^"|"$/g, '').replace(/^'|'$/g, '')).filter(s => s.length > 0);
  }
  // Fallback: split by lines
  return t
    .split('\n')
    .map(s => s.replace(/^[-*\d\.)\s]+/, '').trim())
    .map(s => s.replace(/^"|"$/g, '').replace(/^'|'$/g, ''))
    .filter(s => s.length > 0);
}

// Proxy endpoint for watsonx text generation
app.post('/generate', async (req, res) => {
  try {
    const { endpoint, accessToken, prompt, count } = req.body;
    
    const genUrl = `${endpoint.replace(/\/$/, '')}/ml/v1/text/chat?version=2023-05-29`;
    const wxBody = {
      messages: [
    {
      role: "system",
      content: "You are a helpful assistant that generates domain-specific lists."
    },
    {
      role: "user",
      content: `Generate exactly ${count} unique, realistic ${prompt} values.
Output only a JSON array of strings, with no commentary, no numbering, no placeholders like single letters.
Each item should be 2-4 words and domain-relevant.`
    }
  ],
      parameters: {
        decoding_method: 'sample',
        temperature: 0.85,
        top_p: 0.9,
        top_k: 50,
        repetition_penalty: 1.1,
        max_new_tokens: 128
      },
      model_id: MODEL_ID,
      project_id: PROJECT_ID
    };

    const genRes = await fetch(genUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(wxBody)
    });

    if (!genRes.ok) {
      const errorText = await genRes.text();
      throw new Error(`watsonx error: ${genRes.status} ${errorText}`);
    }

    const genData = await genRes.json();
    
    // Ensure the response is correctly extracted
    let text = '';
    if (genData.choices && genData.choices[0] && genData.choices[0].message) {
      text = genData.choices[0].message.content;
    } else if (Array.isArray(genData.results) && genData.results[0]?.generated_text) {
      text = genData.results[0].generated_text;
    } else {
      text = String(genData.output || '');
    }

    // Debug: Log the extracted text
    console.log('=== DEBUG: Extracted text from watsonx.ai response ===');
    console.log(text);
    console.log('=== END DEBUG ===');

    // Pass the extracted text to normalizeToList
    let list = normalizeToList(text);
    // Ensure we have at least 'count' values by cycling
    if (list.length === 0) list = [];
    if (list.length < count) {
      const needed = count - list.length;
      for (let i = 0; i < needed; i++) list.push(list[i % Math.max(1, list.length)] || '');
    }
    list = list.slice(0, count);

    res.json({ data: list });
  } catch (error) {
    console.error('Generate proxy error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Proxy endpoint to generate a full table (headers + rows)
app.post('/generateTable', async (req, res) => {
  try {
    const { endpoint, accessToken, prompt, rows, cols } = req.body;

    const genUrl = `${endpoint.replace(/\/$/, '')}/ml/v1/text/chat?version=2023-05-29`;
    const headersPlaceholder = Array.from({ length: cols }, (_, i) => `"Header${i + 1}"`).join(", ");
const rowsPlaceholder = Array.from({ length: rows }, (_, r) => {
  const colsStr = Array.from({ length: cols }, (_, c) => `"Row${r + 1}Col${c + 1}"`).join(", ");
  return `[${colsStr}]`;
}).join(",\n    ");

    const schemaInstruction = `You are generating a table for the given prompt.

IMPORTANT: You must return ONLY a valid JSON object with this exact structure:

{
  "headers": ["Header1", "Header2", ..., "Header${cols}"],
  "rows": [
    ["Value1", "Value2", ..., "Value${cols}"],
    ... ${rows} total rows, each with exactly ${cols} items ...
  ]
}

CRITICAL RULES:
- Return ONLY the JSON object above, nothing else
- Headers: exactly ${cols} plain text labels (1-3 words each)
- Rows: exactly ${rows} rows
- Each row: exactly ${cols} plain text values (1-4 words each)
- NO nested objects, NO arrays inside cells, NO key:value pairs
- NO markdown, NO commentary, NO code fences
- If you cannot follow this format, return: {"headers": [], "rows": []}

Prompt context: ${prompt}`;

    // Debug: Log the complete prompt being sent to watsonx.ai
    console.log('=== DEBUG: Complete prompt sent to watsonx.ai ===');
    console.log(schemaInstruction);
    console.log('=== END DEBUG ===');

    const wxBody = {
      messages: [
    {
      role: "system",
      content: "You are a strict JSON table generator."
    },
    {
      role: "user",
      content: schemaInstruction
    }
  ],
      parameters: {
        decoding_method: 'sample',
        temperature: 0.8,
        top_p: 0.9,
        top_k: 50,
        repetition_penalty: 1.05,
        max_new_tokens: 256
      },
      model_id: MODEL_ID,
      project_id: PROJECT_ID
    };

    // Debug: Log the request body being sent to watsonx.ai
    console.log('=== DEBUG: Request body sent to watsonx.ai ===');
    console.log(JSON.stringify(wxBody, null, 2));
    console.log('=== END DEBUG ===');

    const genRes = await fetch(genUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(wxBody)
    });

    if (!genRes.ok) {
      const errorText = await genRes.text();
      throw new Error(`watsonx error: ${genRes.status} ${errorText}`);
    }

    const genData = await genRes.json();
    let text = '';

    // New extraction logic for the chat endpoint
    if (genData.results && genData.results[0] && genData.results[0].generated_text) {
      text = genData.results[0].generated_text;
    } else if (genData.choices && genData.choices[0] && genData.choices[0].message) {
      text = genData.choices[0].message.content;
    } else {
      console.log('Unexpected response structure:', JSON.stringify(genData, null, 2));
      throw new Error('Unexpected response structure from watsonx.ai');
    }

    // Debug: Log the extracted text
    console.log('=== DEBUG: Extracted text from watsonx.ai response ===');
    console.log(text);
    console.log('=== END DEBUG ===');

    // Continue with your existing cleanup and JSON parsing steps...
    let headers = [];
    let bodyRows = [];

    // Try to parse a JSON object first
    try {
      // Clean common junk: code fences, stray backticks, trailing prose
      let cleaned = text.trim().replace(/^```[a-zA-Z]*\n|```$/g, '').trim();
      
      // Debug: Log the cleaned text before parsing
      console.log('=== DEBUG: Cleaned text before JSON parsing ===');
      console.log(cleaned);
      console.log('=== END DEBUG ===');
      
      // Attempt direct JSON parse
      let obj;
      try { 
        obj = JSON.parse(cleaned); 
      } catch(parseError) {
        console.log('=== DEBUG: Initial JSON parse failed, attempting cleanup ===');
        
        // Fix common JSON issues
        const normalized = cleaned
          .replace(/"?([a-zA-Z0-9_\s]+)"?\s*:/g, '"$1":') // ensure keys are quoted
          .replace(/(^|[^\\])'(.*?)'(?=[,\]\}])/g, (m, p1, p2) => `${p1}"${p2}"`) // fix single quotes
          .replace(/,\s*([\]\}])/g, '$1') // remove trailing commas
          .replace(/\["([^"]*):\s*([^"]*)"\]/g, '["$1", "$2"]') // fix broken key:value arrays
          .replace(/\["([^"]*):\s*([^"]*)"\]/g, '["$1", "$2"]') // fix more broken patterns
          .replace(/\["([^"]*):\s*([^"]*)"\]/g, '["$1", "$2"]'); // fix more broken patterns
        
        console.log('=== DEBUG: Normalized text ===');
        console.log(normalized);
        console.log('=== END DEBUG ===');
        
        try {
          obj = JSON.parse(normalized);
        } catch(secondError) {
          console.log('=== DEBUG: Second JSON parse also failed ===');
          console.log('First error:', parseError.message);
          console.log('Second error:', secondError.message);
          console.log('=== END DEBUG ===');
          throw new Error('Failed to parse JSON after cleanup');
        }
      }
      
      if (obj && Array.isArray(obj.headers) && Array.isArray(obj.rows)) {
        // Validate and clean the data
        headers = obj.headers
          .map(x => String(x))
          .filter(x => x && x.trim() && !x.includes('[') && !x.includes('{')) // filter out malformed entries
          .slice(0, cols);
        
        // bodyRows = obj.rows
        //   .map(r => Array.isArray(r) ? r.map(x => String(x)) : [])
        //   .filter(row => row.length === cols) // only keep rows with correct column count
        //   .slice(0, rows);

          bodyRows = obj.rows
          .map(r => Array.isArray(r) ? r.map(x => String(x)) : [])
          .map(r => r.length > cols ? r.slice(0, cols) : r.concat(Array(cols - r.length).fill("")))
          .filter(row => row.length > 0) // keep non-empty
          .slice(0, rows);
        
        console.log('=== DEBUG: Parsed and cleaned data ===');
        console.log('Headers:', headers);
        console.log('Rows:', bodyRows);
        console.log('=== END DEBUG ===');
      }
    } catch (e) {
      console.log('=== DEBUG: JSON parsing completely failed ===');
      console.log('Error:', e.message);
      console.log('=== END DEBUG ===');
      // Fallback below
    }

    // Fallback: synthesize headers and rows if parsing failed
    if (headers.length !== cols) {
      console.log('=== DEBUG: Using fallback header generation ===');
      // Generate sensible headers based on the prompt and ensure exact column count
      const promptLower = prompt.toLowerCase();

      const userBase = ['User ID', 'Name', 'Email', 'Role', 'Department', 'Status'];
      const userExtras = ['Username', 'Phone', 'Location', 'Manager', 'Last Login', 'Created At', 'Country', 'City'];

      const productBase = ['Product ID', 'Name', 'Category', 'Price', 'Stock', 'Rating'];
      const productExtras = ['SKU', 'Brand', 'Color', 'Weight', 'Dimensions', 'Release Date', 'Supplier', 'Warehouse'];

      const orderBase = ['Order ID', 'Customer', 'Product', 'Quantity', 'Price', 'Date'];
      const orderExtras = ['Status', 'Shipping Address', 'Payment Method', 'Tracking No', 'Sales Rep', 'Discount', 'Tax', 'Total'];

      const perfBase = ['Application', 'Hostname', 'Method', 'Start Time', 'Response Time (ms)', 'Load Time (ms)', 'Downtime (min)', 'Status'];
      const perfExtras = ['Region', 'SLA (%)', 'Error Rate (%)', 'CPU (%)', 'Memory (%)', 'Disk (%)', 'Endpoint', 'Env'];

      let proposed = [];
      if (promptLower.includes('user') || promptLower.includes('management')) {
        proposed = [...userBase, ...userExtras];
      } else if (promptLower.includes('product')) {
        proposed = [...productBase, ...productExtras];
      } else if ((promptLower.includes('order') || promptLower.includes('sales'))) {
        proposed = [...orderBase, ...orderExtras];
      } else if (promptLower.includes('performance') || promptLower.includes('downtime') || promptLower.includes('uptime')) {
        proposed = [...perfBase, ...perfExtras];
      } else {
        proposed = [];
      }

      // Trim or pad to exactly cols
      if (proposed.length >= cols) {
        headers = proposed.slice(0, cols);
      } else {
        headers = [...proposed];
        while (headers.length < cols) headers.push(`Column ${headers.length + 1}`);
      }

      console.log('=== DEBUG: Generated fallback headers ===');
      console.log(headers);
      console.log('=== END DEBUG ===');
    }

    if (bodyRows.length !== rows) {
      console.log('=== DEBUG: Using fallback row generation ===');

      // Helpers for realistic values
      const firstNames = ['Liam','Noah','Oliver','Elijah','James','William','Benjamin','Lucas','Henry','Alexander','Emma','Olivia','Ava','Isabella','Sophia','Mia','Charlotte','Amelia','Harper','Evelyn'];
      const lastNames = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez','Hernandez','Lopez','Gonzalez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin'];
      const roles = ['Admin','Manager','Editor','Viewer','Analyst','Developer','Designer','Support'];
      const departments = ['Engineering','Sales','Marketing','Finance','HR','Operations','Customer Success','IT'];
      const cities = ['New York','San Francisco','London','Berlin','Paris','Toronto','Sydney','Tokyo'];

      const httpMethods = ['GET','POST','PUT','DELETE','PATCH'];
      const regions = ['us-east-1','us-west-2','eu-central-1','ap-south-1'];
      const envs = ['prod','staging','dev'];

      const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
      const randomName = () => `${rand(firstNames)} ${rand(lastNames)}`;
      const usernameFrom = (name) => name.toLowerCase().replace(/[^a-z]+/g,'').slice(0,12);
      const emailFrom = (name, i) => `${usernameFrom(name)}${i+1}@example.com`;
      const phone = () => `+1-${Math.floor(200+Math.random()*700)}-${Math.floor(200+Math.random()*700)}-${String(Math.floor(1000+Math.random()*9000))}`;
      const id = (i) => `USR-${1000 + i}`;
      const dateRecent = () => {
        const d = new Date(Date.now() - Math.floor(Math.random()*1000*60*60*24*90));
        return d.toISOString().slice(0,10);
      };
      const timeOfDay = () => {
        const d = new Date(Date.now() - Math.floor(Math.random()*1000*60*60*24*7));
        return d.toISOString().replace('T',' ').slice(0,19);
      };
      const hostname = (i) => `host${i+1}.example.com`;
      const endpoint = (i) => `/api/v${1+ (i%3)}/resource/${100 + i}`;
      const pct = (min,max) => (min + Math.random()*(max-min)).toFixed(1);
      const int = (min,max) => Math.floor(min + Math.random()*(max-min+1));

      bodyRows = Array.from({ length: rows }, (_, r) => {
        const name = randomName();
        const row = [];
        for (let c = 0; c < cols; c++) {
          const h = (headers[c] || '').toLowerCase();
          // User management mapping
          if (h.includes('user id') || (h === 'id') || (h === 'userid') || (h.includes('id') && !h.includes('order') && !h.includes('product'))) row.push(id(r));
          else if (h === 'name' || h.includes('full name')) row.push(name);
          else if (h.includes('username')) row.push(usernameFrom(name));
          else if (h.includes('email')) row.push(emailFrom(name, r));
          else if (h.includes('role')) row.push(rand(roles));
          else if (h.includes('department')) row.push(rand(departments));
          else if (h.includes('status') && !(h.includes('http') || h.includes('code'))) row.push(r % 2 === 0 ? 'Active' : 'Inactive');
          else if (h.includes('phone')) row.push(phone());
          else if (h.includes('location') || h.includes('city')) row.push(rand(cities));
          else if (h.includes('manager')) row.push(randomName());
          else if (h.includes('last login')) row.push(dateRecent());
          else if (h.includes('created')) row.push(dateRecent());
          else if (h.includes('updated')) row.push(dateRecent());
          // Performance/downtime mapping
          else if (h.includes('application')) row.push(`Application ${r+1}`);
          else if (h.includes('hostname')) row.push(hostname(r));
          else if (h.includes('method')) row.push(rand(httpMethods));
          else if (h.includes('start time')) row.push(timeOfDay());
          else if (h.includes('response time')) row.push(String(int(50, 1200)));
          else if (h.includes('load time')) row.push(String(int(200, 5000)));
          else if (h.includes('downtime')) row.push(String(int(0, 120)));
          else if (h.includes('sla')) row.push(pct(95, 99.99));
          else if (h.includes('error rate')) row.push(pct(0, 5));
          else if (h.includes('cpu')) row.push(pct(5, 95));
          else if (h.includes('memory')) row.push(pct(5, 95));
          else if (h.includes('disk')) row.push(pct(5, 95));
          else if (h.includes('endpoint')) row.push(endpoint(r));
          else if (h.includes('env')) row.push(rand(envs));
          else if (h.includes('region')) row.push(rand(regions));
          else if (h === 'status') row.push(int(0,1) ? 'Up' : 'Down');
          else row.push(`Value ${r + 1}-${c + 1}`);
        }
        return row;
      });

      console.log('=== DEBUG: Generated fallback rows ===');
      console.log(bodyRows);
      console.log('=== END DEBUG ===');
    }

    return res.json({ headers, rows: bodyRows });
  } catch (error) {
    console.error('GenerateTable proxy error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/analytics', async (req, res) => {
  try {
    const { event, anonId, props, ts } = req.body || {};
    
    if (process.env.GA4_MEASUREMENT_ID && process.env.GA4_API_SECRET) {
      const ga4Url = `https://www.google-analytics.com/mp/collect?measurement_id=${process.env.GA4_MEASUREMENT_ID}&api_secret=${process.env.GA4_API_SECRET}`;
      const ga4Payload = {
        client_id: anonId || 'anon',
        timestamp_micros: ts ? String(ts * 1000) : undefined,
        events: [{ name: event || 'event', params: props || {} }],
      };
      
      const ga4Res = await fetch(ga4Url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ga4Payload),
      });
      
      if (ga4Res.ok) {
        console.log(`[analytics] ✅ Sent event "${event}" to GA4`);
      } else {
        console.warn(`[analytics] ⚠️ GA4 responded with status ${ga4Res.status}`);
      }
    } else {
      console.log('[analytics] (dev) event', { event, anonId, props, ts });
    }
  } catch (e) {
    console.warn('[analytics] forward failed', e);
  } finally {
    res.sendStatus(204);
  }
});

app.listen(PORT, () => {
  console.log(`Proxy server running on http://localhost:${PORT}`);
  console.log('Available endpoints:');
  console.log('  POST /token - Get IAM access token');
  console.log('  POST /generate - Generate text with watsonx.ai');
  console.log('  POST /generateTable - Generate headers + rows with watsonx.ai');
  console.log('  POST /analytics - Forward analytics events to GA4');
  console.log(`GA4 Analytics: ${process.env.GA4_MEASUREMENT_ID ? '✅ Configured' : '⚠️ Not configured (dev mode)'}`);
});
