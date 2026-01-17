const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const WebScout = require('./webscout');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Anthropic client (uses ANTHROPIC_API_KEY env var automatically)
const anthropic = new Anthropic();

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// =========================================================
// WEBSCOUT CANDIDATES ENDPOINT
// =========================================================
// Returns licensed image candidates + link candidates
// Only from allowlisted sources with verified licenses

app.get('/api/candidates', async (req, res) => {
  try {
    const surfaces = req.query.surfaces?.split(',') || ['all'];
    const limit = Math.min(parseInt(req.query.limit) || 5, 20);
    
    console.log(`🔍 WebScout: Fetching candidates for surfaces: ${surfaces.join(', ')}, limit: ${limit}`);
    
    const candidates = await WebScout.harvestCandidates(surfaces, limit);
    
    console.log(`✅ WebScout: Found ${candidates.img.length} image candidates, ${candidates.lnk.length} link candidates`);
    
    res.json({
      v: 1,
      t: 'candidates',
      img: candidates.img,
      lnk: candidates.lnk,
      licenses: {
        render_allowed: WebScout.RENDER_ALLOWED_LICENSES,
        attribution_required: WebScout.ATTRIBUTION_REQUIRED
      },
      ts: new Date().toISOString()
    });
  } catch (error) {
    console.error('WebScout error:', error);
    res.status(500).json({
      error: 'Failed to fetch candidates',
      message: error.message
    });
  }
});

// Generate AI Insight
app.post('/api/insight', async (req, res) => {
  try {
    const {
      recentSurfaces = [],
      topInterests = [],
      sessionDuration = 0,
      timeOfDay = 'day',
      cardsViewed = 0
    } = req.body;

    // Build context for Claude
    const prompt = buildInsightPrompt({
      recentSurfaces,
      topInterests,
      sessionDuration,
      timeOfDay,
      cardsViewed
    });

    // Call Claude
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    // Parse Claude's response
    const responseText = message.content[0].text;
    const insight = parseInsightResponse(responseText);

    res.json(insight);
  } catch (error) {
    console.error('Error generating insight:', error);
    res.status(500).json({
      error: 'Failed to generate insight',
      message: error.message
    });
  }
});

// Build the prompt for Claude
function buildInsightPrompt({ recentSurfaces, topInterests, sessionDuration, timeOfDay, cardsViewed }) {
  return `You are an AI companion for a discovery feed app called AppScroll. Based on the user's browsing patterns, generate a short, personalized insight that feels like a thoughtful observation from a friend.

USER CONTEXT:
- Recently viewed content types: ${recentSurfaces.join(', ') || 'various'}
- Top interests over time: ${topInterests.join(', ') || 'still learning'}
- Current session: ${sessionDuration} minutes, ${cardsViewed} cards viewed
- Time of day: ${timeOfDay}

GUIDELINES:
- Be warm and observational, not preachy
- Notice patterns they might not see themselves
- Keep it brief (2-3 sentences max)
- Occasionally suggest something novel based on their interests
- Never be creepy or invasive
- Vary your style: sometimes reflective, sometimes curious, sometimes playful

Respond ONLY with valid JSON in this exact format:
{
  "title": "A short catchy title (3-6 words)",
  "content": "Your 2-3 sentence insight here",
  "category": "one of: pattern, discovery, reflection, suggestion",
  "tags": ["tag1", "tag2", "tag3"]
}`;
}

// Parse Claude's JSON response
function parseInsightResponse(text) {
  try {
    // Try to extract JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.error('Failed to parse insight JSON:', e);
  }

  // Fallback if parsing fails
  return {
    title: "A Moment of Discovery",
    content: text.slice(0, 200),
    category: "reflection",
    tags: ["insight"]
  };
}

// =========================================================
// AI ARTIFACT CARD ENDPOINT (Legacy single-card)
// Token-efficient SignalPacket -> CardSpec transformation
// =========================================================

app.post('/api/artifact-card', async (req, res) => {
  try {
    const packet = req.body;
    
    // Validate packet structure
    if (!packet.v || packet.t !== 'sig' || !packet.d || !packet.c || !packet.lim) {
      return res.status(400).json({
        error: 'Invalid SignalPacket structure',
        message: 'Missing required fields: v, t, d, c, lim'
      });
    }

    // Build the prompt for CardSpec generation
    const prompt = buildArtifactCardPrompt(packet);

    // Call Claude with strict JSON mode
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    // Parse and validate CardSpec response
    const responseText = message.content[0].text;
    const cardSpec = parseCardSpecResponse(responseText, packet);

    res.json(cardSpec);
  } catch (error) {
    console.error('Error generating artifact card:', error);
    
    // Return fallback CardSpec on error
    const fallback = generateFallbackCardSpec(req.body);
    res.json(fallback);
  }
});

// =========================================================
// COMPETING CARDS ENDPOINT (New multi-candidate)
// Generates 2 CardSpecs with different classes; Arbiter selects winner
// =========================================================

app.post('/api/competing-cards', async (req, res) => {
  try {
    const packet = req.body;
    
    // Validate packet structure (now includes cls, ph, fat)
    if (!packet.v || packet.t !== 'sig' || !packet.d || !packet.c || !packet.lim) {
      return res.status(400).json({
        error: 'Invalid SignalPacket structure',
        message: 'Missing required fields: v, t, d, c, lim'
      });
    }
    
    if (!packet.cls || packet.cls.length < 2) {
      return res.status(400).json({
        error: 'Invalid SignalPacket',
        message: 'Missing or insufficient cls (allowed classes) field'
      });
    }

    // Build the prompt for competing cards generation
    const prompt = buildCompetingCardsPrompt(packet);

    // Call Claude
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    // Parse and validate CardsEnvelope response
    const responseText = message.content[0].text;
    const envelope = parseCompetingCardsResponse(responseText, packet);

    res.json(envelope);
  } catch (error) {
    console.error('Error generating competing cards:', error);
    
    // Return fallback envelope on error
    const fallback = generateFallbackEnvelope(req.body);
    res.json(fallback);
  }
});

// Build prompt for competing cards generation
function buildCompetingCardsPrompt(packet) {
  const desireLabels = ['ORI', 'CONN', 'COMP', 'MEAN', 'REG'];
  const desireStr = packet.d.map((p, i) => `${desireLabels[i]}:${Math.round(p * 100)}%`).join(' ');
  const phaseMap = { 'hook': 'HOOK', 'lock': 'LOCK-IN', 'rein': 'REINFORCE', 'rel': 'RELEASE' };
  const phaseName = phaseMap[packet.ph] || packet.ph;
  
  // Format fatigue
  const fatigueStr = packet.cls.map(cls => {
    const fatVal = packet.fat?.[cls] || 0;
    return `${cls}:${Math.round(fatVal * 100)}%`;
  }).join(' ');
  
  return `You are AppScroll Card Composer. Output JSON only. No commentary. No markdown.
You must return EXACTLY 2 competing card candidates using DIFFERENT classes from packet.cls.
Use only packet candidates; do not invent data. Keep within packet.lim. Never infer identity.

SIGNALPACKET:
${JSON.stringify(packet, null, 2)}

DESIRE STATE: ${desireStr}
SESSION PHASE: ${phaseName}
MODE: ${packet.m} | TIME: ${packet.ctx.tod} | SCROLL: ${packet.ctx.sl.toFixed(2)}
CLASS FATIGUE: ${fatigueStr}
ALLOWED CLASSES: ${packet.cls.join(', ')}

TASK:
- Generate exactly 2 CardSpec candidates inside a {"v":1,"t":"cards","c":[...]} envelope.
- Each candidate MUST have a different "k" (card class) from packet.cls.
- Choose image/stats/badges from packet.c.* only.
- Copy must be short, punchy, Tech-OS tone.
- Quotes must be grounding, not manipulative; no personal claims.
- Respect fatigue: avoid high-fatigue classes unless strongly aligned with desire/phase.

CLASS INTENTS:
- sig_sum: headline "TODAY'S SIGNALS" + 1–2 stats + 2–3 badges + calm directive quote
- flow_next: "NEXT MOVE" framing + 1–2 action-like stats (time/steps ok) + return-friendly language
- calm_reset: reduce intensity; minimal stats; calming language; "MOMENT OF CALM" title
- anomaly: highlight 1 surprising signal (outlier) using existing data; avoid sensationalism; "OUTLIER DETECTED" style
- culture_lens: use image/art/history framing; connect to meaning; minimal stats; "DEEPER SIGNAL" style

OUTPUT FORMAT (JSON only):
{
  "v": 1,
  "t": "cards",
  "c": [
    {
      "v": 1,
      "t": "card",
      "k": "CLASS_KEY",
      "ttl": "TITLE",
      "sub": "subline",
      "img": {"id": "from packet.c.img", "u": "url", "cap": "1-line image description", "src": "IMAGE SOURCE", "lic": "LICENSE_CODE", "att": "attribution if required"} or null,
      "st": [{"l": "LABEL", "v": "VALUE", "d": "up|dn|flat", "n": "optional note"}],
      "qt": "QUOTE TEXT",
      "by": "SignalEngine",
      "bg": [{"i": "bolt|wave|target|sun|moon|star|chart|shield|leaf", "t": "badge text"}],
      "src": [{"r": "img|fin|news", "id": "candidate id"}]
    },
    { ... second card with different k ... }
  ]
}

IMAGE LICENSE RULES:
- ONLY use images from packet.c.img that have a safe license (PD, CC0, CCBY, CCBYSA, NASA_PD)
- If img.lic is "UNKNOWN" or "NOT_ALLOWED", set img to null instead
- Copy the "lic" and "att" fields from the source candidate to the CardSpec
- The "att" field must be shown to users for CCBY, CCBYSA, and NASA_PD licensed images

IMAGE CAPTION RULES:
- cap: Write a compelling 1-line description (under 80 chars) that adds context to the image
- src: Use packet.c.img[].src for the source name (e.g. "NASA APOD", "Unsplash", "Met Museum")
- Make cap evocative but factual - describe WHAT is shown, not feelings`;
}

// Build prompt for artifact card generation
function buildArtifactCardPrompt(packet) {
  const desireLabels = ['ORI', 'CONN', 'COMP', 'MEAN', 'REG'];
  const desireStr = packet.d.map((p, i) => `${desireLabels[i]}:${Math.round(p * 100)}%`).join(' ');
  
  return `You are a card composer for AppScroll. Output ONLY valid JSON matching CardSpec schema.
NO commentary. NO markdown. Use ONLY provided candidates. Never infer identity.

SIGNALPACKET:
${JSON.stringify(packet, null, 2)}

DESIRE STATE: ${desireStr}
MODE: ${packet.m} | TIME: ${packet.ctx.tod} | SCROLL: ${packet.ctx.sl.toFixed(2)}

TASK:
1. Choose best image from packet.c.img based on desire + context
2. Choose up to ${packet.lim.st} stats from packet.c.fin (format nicely)
3. Choose up to ${packet.lim.bg} badges from packet.c.tag
4. Write quote <= ${packet.lim.qt} chars (calming, not manipulative)
5. Title <= ${packet.lim.ttl} chars (usually "TODAY'S SIGNALS" unless calm mode)

HEURISTICS:
- High ORI or high scroll -> prefer "signals" + finance + system tone
- High REG -> calmer imagery + fewer stats + softer quote
- Night -> avoid high-arousal language
- Prefer resolution over escalation

OUTPUT CardSpec JSON ONLY:
{
  "v": 1,
  "t": "card",
  "k": "sig"|"calm"|"tool"|"culture",
  "ttl": "TITLE",
  "sub": "subline",
  "img": {"id": "from packet.c.img", "u": "url", "cap": "1-line image description", "src": "IMAGE SOURCE"},
  "st": [{"l": "LABEL", "v": "VALUE", "d": "up|dn|flat", "n": "optional note"}],
  "qt": "QUOTE TEXT",
  "by": "SignalEngine",
  "bg": [{"i": "bolt|wave|target|sun|moon|star|chart|shield|leaf", "t": "badge text"}],
  "src": [{"r": "img|fin|news", "id": "candidate id"}]
}

IMAGE CAPTION RULES:
- cap: Write a compelling 1-line description (under 80 chars) that adds context
- src: Use packet.c.img[].src for source name (e.g. "NASA APOD", "Unsplash")
- Make cap evocative but factual - describe WHAT is shown, not feelings`;
}

// Parse CardSpec from Claude response
function parseCardSpecResponse(text, packet) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const spec = JSON.parse(jsonMatch[0]);
      
      // Validate and sanitize
      return sanitizeCardSpec(spec, packet);
    }
  } catch (e) {
    console.error('Failed to parse CardSpec JSON:', e);
  }
  
  // Return fallback
  return generateFallbackCardSpec(packet);
}

// Parse CardsEnvelope from Claude response
function parseCompetingCardsResponse(text, packet) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const envelope = JSON.parse(jsonMatch[0]);
      
      // Validate envelope structure
      if (envelope.v === 1 && envelope.t === 'cards' && Array.isArray(envelope.c)) {
        // Sanitize each card
        const sanitizedCards = envelope.c.map(spec => sanitizeCardSpec(spec, packet));
        
        // Ensure distinct classes
        const classes = sanitizedCards.map(s => s.k);
        if (new Set(classes).size === classes.length) {
          return {
            v: 1,
            t: 'cards',
            c: sanitizedCards
          };
        }
      }
    }
  } catch (e) {
    console.error('Failed to parse CardsEnvelope JSON:', e);
  }
  
  // Return fallback
  return generateFallbackEnvelope(packet);
}

// Sanitize CardSpec to enforce limits and safety
function sanitizeCardSpec(spec, packet) {
  const lim = packet.lim;
  
  // Enforce string limits
  if (spec.ttl && spec.ttl.length > lim.ttl) {
    spec.ttl = spec.ttl.slice(0, lim.ttl);
  }
  if (spec.sub && spec.sub.length > lim.sub) {
    spec.sub = spec.sub.slice(0, lim.sub);
  }
  if (spec.qt && spec.qt.length > lim.qt) {
    spec.qt = spec.qt.slice(0, lim.qt);
  }
  
  // Enforce array limits
  if (spec.st && spec.st.length > lim.st) {
    spec.st = spec.st.slice(0, lim.st);
  }
  if (spec.bg && spec.bg.length > lim.bg) {
    spec.bg = spec.bg.slice(0, lim.bg);
  }
  
  // Safety check: remove creepy personalization
  const unsafePatterns = ['you seem', 'i know you', 'your mood', 'your feelings', 'your identity'];
  const qtLower = (spec.qt || '').toLowerCase();
  const ttlLower = (spec.ttl || '').toLowerCase();
  
  for (const pattern of unsafePatterns) {
    if (qtLower.includes(pattern) || ttlLower.includes(pattern)) {
      spec.qt = 'SIGNALS NOTED. CARRY ON.';
      break;
    }
  }
  
  // Ensure required fields
  spec.v = 1;
  spec.t = 'card';
  
  // Validate card class
  const validClasses = ['sig_sum', 'flow_next', 'calm_reset', 'anomaly', 'culture_lens'];
  if (!validClasses.includes(spec.k)) {
    spec.k = 'sig_sum';
  }
  
  spec.by = spec.by || 'SignalEngine';
  spec.src = spec.src || [];
  
  return spec;
}

// Generate deterministic fallback CardsEnvelope
function generateFallbackEnvelope(packet) {
  const allowedClasses = packet.cls || ['sig_sum', 'calm_reset'];
  
  // Pick first two allowed classes
  const class1 = allowedClasses[0] || 'sig_sum';
  const class2 = allowedClasses[1] || (class1 === 'sig_sum' ? 'calm_reset' : 'sig_sum');
  
  return {
    v: 1,
    t: 'cards',
    c: [
      generateCardSpecForClass(class1, packet),
      generateCardSpecForClass(class2, packet)
    ]
  };
}

// Generate a CardSpec for a specific class
function generateCardSpecForClass(cardClass, packet) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  
  const img = packet.c?.img?.[0] || null;
  
  // Helper to create image ref with license info
  const makeImageRef = (imgCandidate) => {
    if (!imgCandidate) return null;
    return {
      id: imgCandidate.id,
      u: imgCandidate.u,
      cap: imgCandidate.ttl || null,
      src: imgCandidate.src || null,
      lic: imgCandidate.lic || null,
      att: imgCandidate.att || null,
      link: imgCandidate.link || null
    };
  };
  
  switch (cardClass) {
    case 'flow_next':
      return {
        v: 1,
        t: 'card',
        k: 'flow_next',
        ttl: 'NEXT MOVE',
        sub: 'Your forward path',
        img: null,
        st: [
          { l: 'TIME', v: '~5 min', d: 'flat', n: null },
          { l: 'ACTION', v: 'Return', d: 'up', n: null }
        ],
        qt: 'MOVE FORWARD. RETURN WHEN READY.',
        by: 'SignalEngine',
        bg: [{ i: 'bolt', t: 'action ready' }],
        src: []
      };
      
    case 'calm_reset':
      return {
        v: 1,
        t: 'card',
        k: 'calm_reset',
        ttl: 'MOMENT OF CALM',
        sub: 'A pause in the signal stream',
        img: makeImageRef(img),
        st: [],
        qt: 'BREATHE. THE WORLD KEEPS TURNING.',
        by: 'SignalEngine',
        bg: [{ i: 'leaf', t: 'settle' }],
        src: img ? [{ r: 'img', id: img.id }] : []
      };
      
    case 'anomaly':
      const anomalyStat = packet.c?.fin?.find(f => Math.abs(f.ch) > 5) || packet.c?.fin?.[0];
      return {
        v: 1,
        t: 'card',
        k: 'anomaly',
        ttl: 'OUTLIER DETECTED',
        sub: 'Unusual signal activity',
        img: null,
        st: anomalyStat ? [{
          l: anomalyStat.sym,
          v: `${anomalyStat.ch >= 0 ? '+' : ''}${anomalyStat.ch.toFixed(1)}%`,
          d: anomalyStat.ch >= 0 ? 'up' : 'dn',
          n: Math.abs(anomalyStat.ch) > 10 ? 'Spike' : null
        }] : [],
        qt: 'NOTED. MONITOR AND PROCEED.',
        by: 'SignalEngine',
        bg: [{ i: 'shield', t: 'anomaly' }],
        src: anomalyStat ? [{ r: 'fin', id: anomalyStat.id }] : []
      };
      
    case 'culture_lens':
      const artImg = packet.c?.img?.find(i => i.k === 'art' || i.k === 'space') || img;
      return {
        v: 1,
        t: 'card',
        k: 'culture_lens',
        ttl: 'DEEPER SIGNAL',
        sub: 'A moment of perspective',
        img: makeImageRef(artImg),
        st: [],
        qt: 'PERSPECTIVE SHIFTS. MEANING EMERGES.',
        by: 'SignalEngine',
        bg: [{ i: 'star', t: 'meaning' }],
        src: artImg ? [{ r: 'img', id: artImg.id }] : []
      };
      
    case 'sig_sum':
    default:
      const stats = (packet.c?.fin || []).slice(0, 2).map(fin => ({
        l: fin.sym,
        v: fin.px > 0 ? `$${fin.px.toLocaleString()}` : `${fin.ch >= 0 ? '+' : ''}${fin.ch.toFixed(1)}%`,
        d: fin.ch >= 0 ? 'up' : 'dn',
        n: Math.abs(fin.ch) > 5 ? (fin.ch > 0 ? 'Surge' : 'Drop') : null
      }));
      
      const badges = (packet.c?.tag || []).slice(0, 3).map(tag => ({
        i: iconForTag(tag),
        t: tag
      }));
      
      return {
        v: 1,
        t: 'card',
        k: 'sig_sum',
        ttl: "TODAY'S SIGNALS",
        sub: `${dateStr} · ${timeStr} · ${(packet.m || 'sync').charAt(0).toUpperCase() + (packet.m || 'sync').slice(1)}`,
        img: makeImageRef(img),
        st: stats,
        qt: 'SIGNALS NOTED. CARRY ON.',
        by: 'SignalEngine',
        bg: badges,
        src: buildSources(packet)
      };
  }
}

function iconForTag(tag) {
  const lower = tag.toLowerCase();
  if (lower.includes('calm') || lower.includes('settle')) return 'leaf';
  if (lower.includes('active') || lower.includes('system')) return 'bolt';
  if (lower.includes('morning') || lower.includes('sun')) return 'sun';
  if (lower.includes('evening') || lower.includes('night')) return 'moon';
  if (lower.includes('focus')) return 'target';
  return 'chart';
}

function buildSources(packet) {
  const sources = [];
  if (packet.c?.img?.[0]) sources.push({ r: 'img', id: packet.c.img[0].id });
  (packet.c?.fin || []).slice(0, 2).forEach(f => sources.push({ r: 'fin', id: f.id }));
  return sources;
}

// Legacy single-card fallback (backward compatibility)
function generateFallbackCardSpec(packet) {
  return generateCardSpecForClass('sig_sum', packet);
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 AppScroll backend running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🔍 WebScout Candidates: GET http://localhost:${PORT}/api/candidates`);
  console.log(`🧠 Insight API: POST http://localhost:${PORT}/api/insight`);
  console.log(`🎴 Artifact Card API: POST http://localhost:${PORT}/api/artifact-card`);
  console.log(`🎯 Competing Cards API: POST http://localhost:${PORT}/api/competing-cards`);
});
