// =========================================================
// WEBSCOUT - Licensed Content Harvester
// =========================================================
// Fetches ONLY from allowlisted sources with verified licenses
// Returns LicensedCandidate objects with full provenance
// =========================================================

const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// =========================================================
// LICENSE ENUM
// =========================================================

const License = {
  PD: 'PD',           // Public Domain
  CC0: 'CC0',         // CC0 Public Domain Dedication
  CCBY: 'CCBY',       // CC BY (requires attribution)
  CCBYSA: 'CCBYSA',   // CC BY-SA (requires attribution + share-alike)
  NASA_PD: 'NASA_PD', // NASA media (public domain with attribution requested)
  UNKNOWN: 'UNKNOWN', // License unknown - DO NOT USE for image cards
  NOT_ALLOWED: 'NOT_ALLOWED' // Explicitly not reusable
};

// Licenses that allow image rendering
const RENDER_ALLOWED_LICENSES = [License.PD, License.CC0, License.CCBY, License.CCBYSA, License.NASA_PD];

// Licenses that require attribution display
const ATTRIBUTION_REQUIRED = [License.CCBY, License.CCBYSA, License.NASA_PD];

// =========================================================
// LICENSED CANDIDATE STRUCTURE
// =========================================================

/**
 * @typedef {Object} LicensedCandidate
 * @property {string} id - Unique identifier (source:itemId)
 * @property {string} u - Thumbnail/display URL
 * @property {string} k - Kind: space|earth|art|photo|culture|link
 * @property {string} ttl - Title (truncated)
 * @property {string} desc - Short description (optional)
 * @property {string} src - Source name
 * @property {string} lic - License enum value
 * @property {string} att - Attribution text (required for CCBY/CCBYSA)
 * @property {string} link - Canonical source URL (for link-out)
 * @property {boolean} safe - Passed basic safety checks
 */

// =========================================================
// ALLOWLISTED SOURCE FETCHERS
// =========================================================

/**
 * NASA APOD - Astronomy Picture of the Day
 * License: NASA_PD (public domain, attribution requested)
 */
async function fetchNASAAPOD(limit = 5) {
  const apiKey = process.env.NASA_API_KEY || 'DEMO_KEY';
  const candidates = [];
  
  try {
    // Fetch recent APODs
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - limit * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    const response = await fetch(
      `https://api.nasa.gov/planetary/apod?api_key=${apiKey}&start_date=${startDate}&end_date=${endDate}`
    );
    
    if (!response.ok) {
      console.error('NASA APOD fetch failed:', response.status);
      return candidates;
    }
    
    const data = await response.json();
    const items = Array.isArray(data) ? data : [data];
    
    for (const item of items.slice(0, limit)) {
      // Skip videos (no thumbnail available without additional processing)
      if (item.media_type === 'video') continue;
      
      candidates.push({
        id: `nasa:apod:${item.date}`,
        u: item.url,
        k: 'space',
        ttl: truncate(item.title, 50),
        desc: truncate(item.explanation, 100),
        src: 'NASA APOD',
        lic: License.NASA_PD,
        att: item.copyright ? `© ${item.copyright} — NASA APOD` : 'NASA/Public Domain',
        link: `https://apod.nasa.gov/apod/ap${item.date.replace(/-/g, '').slice(2)}.html`,
        safe: basicSafetyCheck(item.title + ' ' + item.explanation)
      });
    }
  } catch (error) {
    console.error('NASA APOD error:', error.message);
  }
  
  return candidates;
}

/**
 * NASA EPIC - Earth Polychromatic Imaging Camera
 * License: NASA_PD
 */
async function fetchNASAEPIC(limit = 3) {
  const apiKey = process.env.NASA_API_KEY || 'DEMO_KEY';
  const candidates = [];
  
  try {
    const response = await fetch(
      `https://api.nasa.gov/EPIC/api/natural?api_key=${apiKey}`
    );
    
    if (!response.ok) return candidates;
    
    const data = await response.json();
    
    for (const item of data.slice(0, limit)) {
      const date = item.date.split(' ')[0].replace(/-/g, '/');
      const imageUrl = `https://epic.gsfc.nasa.gov/archive/natural/${date}/png/${item.image}.png`;
      
      candidates.push({
        id: `nasa:epic:${item.identifier}`,
        u: imageUrl,
        k: 'earth',
        ttl: truncate(item.caption || 'Earth from DSCOVR', 50),
        desc: 'Earth as seen from deep space',
        src: 'NASA EPIC',
        lic: License.NASA_PD,
        att: 'NASA/DSCOVR EPIC',
        link: 'https://epic.gsfc.nasa.gov/',
        safe: true
      });
    }
  } catch (error) {
    console.error('NASA EPIC error:', error.message);
  }
  
  return candidates;
}

/**
 * The Metropolitan Museum of Art Open Access
 * License: CC0 for public domain works
 */
async function fetchMetMuseum(limit = 5) {
  const candidates = [];
  
  try {
    // Search for highlighted works that are public domain
    const searchResponse = await fetch(
      'https://collectionapi.metmuseum.org/public/collection/v1/search?isHighlight=true&hasImages=true&q=*'
    );
    
    if (!searchResponse.ok) return candidates;
    
    const searchData = await searchResponse.json();
    const objectIds = searchData.objectIDs?.slice(0, limit * 3) || []; // Fetch extra since some won't be PD
    
    for (const objectId of objectIds) {
      if (candidates.length >= limit) break;
      
      try {
        const objResponse = await fetch(
          `https://collectionapi.metmuseum.org/public/collection/v1/objects/${objectId}`
        );
        
        if (!objResponse.ok) continue;
        
        const obj = await objResponse.json();
        
        // Only include public domain works
        if (!obj.isPublicDomain || !obj.primaryImageSmall) continue;
        
        candidates.push({
          id: `met:${obj.objectID}`,
          u: obj.primaryImageSmall,
          k: 'art',
          ttl: truncate(obj.title, 50),
          desc: truncate(`${obj.artistDisplayName || 'Unknown'}, ${obj.objectDate || ''}`, 80),
          src: 'The Met Museum',
          lic: License.CC0,
          att: '', // CC0 doesn't require attribution
          link: obj.objectURL,
          safe: basicSafetyCheck(obj.title)
        });
      } catch (e) {
        continue;
      }
    }
  } catch (error) {
    console.error('Met Museum error:', error.message);
  }
  
  return candidates;
}

/**
 * Art Institute of Chicago API
 * License: CC0 for public domain works
 */
async function fetchArtInstituteChicago(limit = 5) {
  const candidates = [];
  
  try {
    const response = await fetch(
      `https://api.artic.edu/api/v1/artworks?fields=id,title,image_id,artist_title,date_display,is_public_domain,thumbnail&is_public_domain=true&limit=${limit}`
    );
    
    if (!response.ok) return candidates;
    
    const data = await response.json();
    const iiifBase = data.config?.iiif_url || 'https://www.artic.edu/iiif/2';
    
    for (const artwork of data.data || []) {
      if (!artwork.image_id || !artwork.is_public_domain) continue;
      
      const imageUrl = `${iiifBase}/${artwork.image_id}/full/843,/0/default.jpg`;
      
      candidates.push({
        id: `artic:${artwork.id}`,
        u: imageUrl,
        k: 'art',
        ttl: truncate(artwork.title, 50),
        desc: truncate(`${artwork.artist_title || 'Unknown'}, ${artwork.date_display || ''}`, 80),
        src: 'Art Institute Chicago',
        lic: License.CC0,
        att: '',
        link: `https://www.artic.edu/artworks/${artwork.id}`,
        safe: basicSafetyCheck(artwork.title)
      });
    }
  } catch (error) {
    console.error('Art Institute Chicago error:', error.message);
  }
  
  return candidates;
}

/**
 * Smithsonian Open Access
 * License: CC0 for open access items
 */
async function fetchSmithsonian(limit = 5) {
  const apiKey = process.env.SMITHSONIAN_API_KEY;
  const candidates = [];
  
  if (!apiKey) {
    console.warn('Smithsonian API key not configured');
    return candidates;
  }
  
  try {
    const response = await fetch(
      `https://api.si.edu/openaccess/api/v1.0/search?q=online_media_type:Images&rows=${limit}&api_key=${apiKey}`
    );
    
    if (!response.ok) return candidates;
    
    const data = await response.json();
    
    for (const row of data.response?.rows || []) {
      const content = row.content;
      if (!content) continue;
      
      // Find an image
      const media = content.descriptiveNonRepeating?.online_media?.media?.[0];
      if (!media?.content) continue;
      
      candidates.push({
        id: `smithsonian:${row.id}`,
        u: media.content,
        k: 'culture',
        ttl: truncate(content.descriptiveNonRepeating?.title?.content || 'Smithsonian Item', 50),
        desc: truncate(content.freetext?.notes?.[0]?.content || '', 80),
        src: 'Smithsonian',
        lic: License.CC0,
        att: '',
        link: content.descriptiveNonRepeating?.guid || 'https://www.si.edu/openaccess',
        safe: basicSafetyCheck(content.descriptiveNonRepeating?.title?.content || '')
      });
    }
  } catch (error) {
    console.error('Smithsonian error:', error.message);
  }
  
  return candidates;
}

/**
 * Europeana API
 * License: Only items with reuse-friendly rights statements
 */
async function fetchEuropeana(limit = 5) {
  const apiKey = process.env.EUROPEANA_API_KEY;
  const candidates = [];
  
  if (!apiKey) {
    console.warn('Europeana API key not configured');
    return candidates;
  }
  
  try {
    // Filter for open licenses
    const response = await fetch(
      `https://api.europeana.eu/record/v2/search.json?wskey=${apiKey}&query=*&rows=${limit * 2}&reusability=open&media=true`
    );
    
    if (!response.ok) return candidates;
    
    const data = await response.json();
    
    for (const item of data.items || []) {
      if (candidates.length >= limit) break;
      
      const imageUrl = item.edmPreview?.[0];
      if (!imageUrl) continue;
      
      // Parse rights statement
      const license = parseEuropeanaRights(item.rights?.[0]);
      if (license === License.UNKNOWN || license === License.NOT_ALLOWED) continue;
      
      candidates.push({
        id: `europeana:${item.id}`,
        u: imageUrl,
        k: 'culture',
        ttl: truncate(item.title?.[0] || 'Europeana Item', 50),
        desc: truncate(item.dcDescription?.[0] || '', 80),
        src: 'Europeana',
        lic: license,
        att: license === License.CCBY || license === License.CCBYSA ? 
          `${item.dcCreator?.[0] || 'Unknown'} — ${rightsToString(license)}` : '',
        link: item.guid || `https://www.europeana.eu/item${item.id}`,
        safe: basicSafetyCheck((item.title?.[0] || '') + ' ' + (item.dcDescription?.[0] || ''))
      });
    }
  } catch (error) {
    console.error('Europeana error:', error.message);
  }
  
  return candidates;
}

/**
 * Unsplash API
 * License: Unsplash license (free to use, attribution appreciated but not required)
 * Note: We treat as CC0-equivalent for our purposes
 */
async function fetchUnsplash(limit = 5, query = 'nature') {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  const candidates = [];
  
  if (!accessKey) {
    console.warn('Unsplash API key not configured');
    return candidates;
  }
  
  try {
    const response = await fetch(
      `https://api.unsplash.com/photos/random?count=${limit}&query=${encodeURIComponent(query)}`,
      {
        headers: {
          'Authorization': `Client-ID ${accessKey}`
        }
      }
    );
    
    if (!response.ok) return candidates;
    
    const photos = await response.json();
    
    for (const photo of photos) {
      // Skip if no valid URL
      const imageUrl = photo.urls?.regular || photo.urls?.small;
      if (!imageUrl) continue;
      
      candidates.push({
        id: `unsplash:${photo.id}`,
        u: imageUrl,
        k: 'photo',
        ttl: truncate(photo.description || photo.alt_description || 'Unsplash Photo', 50),
        desc: truncate(`Photo by ${photo.user?.name || 'Unknown'}`, 60),
        src: 'Unsplash',
        lic: License.CC0, // Unsplash license is essentially free use
        att: `Photo by ${photo.user?.name || 'Unknown'} on Unsplash`,
        link: photo.links?.html || `https://unsplash.com/photos/${photo.id}`,
        safe: basicSafetyCheck((photo.description || '') + ' ' + (photo.alt_description || ''))
      });
    }
  } catch (error) {
    console.error('Unsplash error:', error.message);
  }
  
  return candidates;
}

/**
 * Hacker News - Top Stories
 * License: Link-only (no content copying)
 * Returns as "link" type candidates
 */
async function fetchHackerNews(limit = 5) {
  const candidates = [];
  
  try {
    const topStoriesRes = await fetch('https://hacker-news.firebaseio.com/v0/topstories.json');
    if (!topStoriesRes.ok) return candidates;
    
    const storyIds = await topStoriesRes.json();
    
    for (const id of storyIds.slice(0, limit)) {
      try {
        const storyRes = await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`);
        if (!storyRes.ok) continue;
        
        const story = await storyRes.json();
        if (!story || story.type !== 'story' || !story.url) continue;
        
        candidates.push({
          id: `hn:${story.id}`,
          u: '', // No image for link cards
          k: 'link',
          ttl: truncate(story.title, 60),
          desc: truncate(`${story.score} points · ${story.descendants || 0} comments`, 40),
          src: 'Hacker News',
          lic: License.UNKNOWN, // Link only - don't render images
          att: '',
          link: story.url,
          safe: basicSafetyCheck(story.title)
        });
      } catch (e) {
        continue;
      }
    }
  } catch (error) {
    console.error('Hacker News error:', error.message);
  }
  
  return candidates;
}

/**
 * Wikimedia Commons (carefully filtered)
 * License: Only CC0/PD/CCBY/CCBYSA
 */
async function fetchWikimediaCommons(limit = 5, category = 'Featured_pictures') {
  const candidates = [];
  
  try {
    // Fetch from a known good category
    const response = await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query&generator=categorymembers&gcmtitle=Category:${encodeURIComponent(category)}&gcmtype=file&gcmlimit=${limit * 2}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=800&format=json`
    );
    
    if (!response.ok) return candidates;
    
    const data = await response.json();
    const pages = data.query?.pages || {};
    
    for (const page of Object.values(pages)) {
      if (candidates.length >= limit) break;
      
      const imageinfo = page.imageinfo?.[0];
      if (!imageinfo) continue;
      
      const metadata = imageinfo.extmetadata || {};
      const license = parseWikimediaLicense(metadata.LicenseShortName?.value);
      
      // Only allow verified reuse licenses
      if (!RENDER_ALLOWED_LICENSES.includes(license)) continue;
      
      const artist = metadata.Artist?.value?.replace(/<[^>]*>/g, '') || 'Unknown';
      
      candidates.push({
        id: `wc:${page.pageid}`,
        u: imageinfo.thumburl || imageinfo.url,
        k: 'photo',
        ttl: truncate(page.title.replace('File:', '').replace(/\.[^.]+$/, ''), 50),
        desc: truncate(metadata.ImageDescription?.value?.replace(/<[^>]*>/g, '') || '', 80),
        src: 'Wikimedia Commons',
        lic: license,
        att: ATTRIBUTION_REQUIRED.includes(license) ? 
          `${truncate(artist, 40)} — ${rightsToString(license)}` : '',
        link: imageinfo.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
        safe: basicSafetyCheck(page.title + ' ' + (metadata.ImageDescription?.value || ''))
      });
    }
  } catch (error) {
    console.error('Wikimedia Commons error:', error.message);
  }
  
  return candidates;
}

// =========================================================
// HELPER FUNCTIONS
// =========================================================

function truncate(str, maxLen) {
  if (!str) return '';
  str = str.trim();
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

function basicSafetyCheck(text) {
  if (!text) return true;
  const lower = text.toLowerCase();
  
  // Basic blocklist
  const unsafeTerms = [
    'nsfw', 'nude', 'naked', 'porn', 'xxx', 'sexual', 'erotic',
    'gore', 'graphic violence', 'torture', 'beheading',
    'nazi', 'white supremac', 'kkk', 'hate group'
  ];
  
  for (const term of unsafeTerms) {
    if (lower.includes(term)) return false;
  }
  
  return true;
}

function parseWikimediaLicense(licenseString) {
  if (!licenseString) return License.UNKNOWN;
  const lower = licenseString.toLowerCase();
  
  if (lower.includes('cc0') || lower.includes('public domain') || lower === 'pd') {
    return License.CC0;
  }
  if (lower.includes('cc-by-sa') || lower.includes('cc by-sa')) {
    return License.CCBYSA;
  }
  if (lower.includes('cc-by') || lower.includes('cc by')) {
    return License.CCBY;
  }
  
  return License.UNKNOWN;
}

function parseEuropeanaRights(rightsUrl) {
  if (!rightsUrl) return License.UNKNOWN;
  const lower = rightsUrl.toLowerCase();
  
  if (lower.includes('publicdomain') || lower.includes('cc0') || lower.includes('/mark/')) {
    return License.CC0;
  }
  if (lower.includes('by-sa')) {
    return License.CCBYSA;
  }
  if (lower.includes('/by/')) {
    return License.CCBY;
  }
  if (lower.includes('in-copyright') || lower.includes('orphan-work')) {
    return License.NOT_ALLOWED;
  }
  
  return License.UNKNOWN;
}

function rightsToString(license) {
  switch (license) {
    case License.CCBY: return 'CC BY 4.0';
    case License.CCBYSA: return 'CC BY-SA 4.0';
    case License.CC0: return 'CC0 Public Domain';
    case License.PD: return 'Public Domain';
    case License.NASA_PD: return 'NASA/Public Domain';
    default: return '';
  }
}

// =========================================================
// MAIN HARVEST FUNCTION
// =========================================================

/**
 * Harvest licensed candidates from specified surfaces
 * @param {string[]} surfaces - Array of surface types to fetch
 * @param {number} limit - Max candidates per source
 * @returns {Promise<{img: LicensedCandidate[], lnk: LicensedCandidate[]}>}
 */
async function harvestCandidates(surfaces = ['space', 'art', 'culture', 'tech'], limit = 5) {
  const allImages = [];
  const allLinks = [];
  
  const fetchers = [];
  
  // Map surfaces to fetchers
  if (surfaces.includes('space') || surfaces.includes('all')) {
    fetchers.push(fetchNASAAPOD(limit));
    fetchers.push(fetchNASAEPIC(Math.ceil(limit / 2)));
  }
  
  if (surfaces.includes('art') || surfaces.includes('all')) {
    fetchers.push(fetchMetMuseum(limit));
    fetchers.push(fetchArtInstituteChicago(limit));
  }
  
  if (surfaces.includes('culture') || surfaces.includes('all')) {
    fetchers.push(fetchSmithsonian(limit));
    fetchers.push(fetchEuropeana(limit));
    fetchers.push(fetchWikimediaCommons(limit));
  }
  
  if (surfaces.includes('photo') || surfaces.includes('all')) {
    fetchers.push(fetchUnsplash(limit));
  }
  
  if (surfaces.includes('tech') || surfaces.includes('all')) {
    fetchers.push(fetchHackerNews(limit));
  }
  
  // Execute all fetchers in parallel
  const results = await Promise.allSettled(fetchers);
  
  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const candidate of result.value) {
        // Filter out unsafe content
        if (!candidate.safe) continue;
        
        // VALIDATE required fields - skip malformed candidates
        if (!candidate.id || !candidate.u || !candidate.k || !candidate.ttl || !candidate.src || !candidate.lic) {
          console.warn('Skipping malformed candidate:', candidate.id || 'unknown');
          continue;
        }
        
        // Separate image candidates from link candidates
        if (candidate.k === 'link' || !RENDER_ALLOWED_LICENSES.includes(candidate.lic)) {
          allLinks.push(candidate);
        } else {
          allImages.push(candidate);
        }
      }
    }
  }
  
  // Shuffle and limit
  return {
    img: shuffle(allImages).slice(0, limit * 2),
    lnk: shuffle(allLinks).slice(0, limit)
  };
}

function shuffle(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// =========================================================
// EXPORTS
// =========================================================

module.exports = {
  License,
  RENDER_ALLOWED_LICENSES,
  ATTRIBUTION_REQUIRED,
  harvestCandidates,
  fetchNASAAPOD,
  fetchNASAEPIC,
  fetchMetMuseum,
  fetchArtInstituteChicago,
  fetchSmithsonian,
  fetchEuropeana,
  fetchUnsplash,
  fetchHackerNews,
  fetchWikimediaCommons
};
