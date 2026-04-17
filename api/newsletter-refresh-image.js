// /api/newsletter-refresh-image.js
// Swap the image for a specific story using Pexels. Fetches multiple candidates,
// excludes the currently-assigned URL, and picks randomly so repeated clicks rotate.
// POST { story_id?, query? }
// If query not provided, uses the story's image_suggestion or headline.

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

var PEXELS_KEY = process.env.PEXELS_API_KEY || '';

async function pickPexelsImage(searchTerms, excludeUrl) {
  if (!PEXELS_KEY || !searchTerms) return null;
  try {
    // Random page 1-3 + 10 results per page = lots of variety across repeated clicks
    var page = Math.floor(Math.random() * 3) + 1;
    var resp = await fetch(
      'https://api.pexels.com/v1/search?query=' + encodeURIComponent(searchTerms) +
      '&per_page=10&page=' + page + '&orientation=landscape',
      { headers: { 'Authorization': PEXELS_KEY } }
    );
    if (!resp.ok) return null;
    var data = await resp.json();
    if (!data.photos || data.photos.length === 0) return null;

    // Build candidate URLs, strip the currently-assigned one so clicking rotates
    var candidates = data.photos.filter(function(photo) {
      var baseUrl = photo.src.original.split('?')[0];
      var fullUrl = baseUrl + '?auto=compress&cs=tinysrgb&w=600&h=300&fit=crop';
      return !excludeUrl || fullUrl !== excludeUrl;
    });
    if (candidates.length === 0) candidates = data.photos;

    var pick = candidates[Math.floor(Math.random() * candidates.length)];
    var baseUrl = pick.src.original.split('?')[0];
    return {
      url: baseUrl + '?auto=compress&cs=tinysrgb&w=600&h=300&fit=crop',
      alt: pick.alt || searchTerms,
      photographer: pick.photographer || '',
      page: page
    };
  } catch (e) {
    console.error('Pexels pick failed:', e.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  if (!PEXELS_KEY) return res.status(500).json({ error: 'PEXELS_API_KEY not configured' });

  var storyId = (req.body || {}).story_id || null;
  var customQuery = (req.body || {}).query || '';
  if (!storyId && !customQuery) return res.status(400).json({ error: 'query or story_id required' });

  // Load story for context (current image URL is used to exclude from rotation)
  var story = null;
  if (storyId) {
    try {
      story = await sb.one('newsletter_stories?id=eq.' + storyId + '&select=id,headline,image_suggestion,image_url&limit=1');
    } catch (e) { /* non-fatal */ }
  }

  var suggestion = customQuery || (story && story.image_suggestion) || (story && story.headline) || '';
  var searchTerms = suggestion.replace(/[^a-zA-Z0-9 ]/g, '').trim();
  if (!searchTerms) return res.status(400).json({ error: 'No search terms available' });

  var currentUrl = story && story.image_url ? story.image_url : '';

  var img = await pickPexelsImage(searchTerms, currentUrl);
  if (!img) {
    return res.status(404).json({ error: 'No images found for: ' + searchTerms });
  }

  // Persist to story row
  if (storyId) {
    try {
      await sb.mutate('newsletter_stories?id=eq.' + storyId, 'PATCH', {
        image_url: img.url,
        image_alt: img.alt,
        updated_at: new Date().toISOString()
      });
    } catch (e) { /* non-fatal, URL still returned */ }
  }

  return res.status(200).json({
    success: true,
    image_url: img.url,
    image_alt: img.alt,
    search_query: searchTerms,
    page: img.page
  });
};
