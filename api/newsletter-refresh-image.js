// /api/newsletter-refresh-image.js
// Searches Pexels for a new image for a specific story.
// POST { story_id, query? }
// If query not provided, uses the story's image_suggestion or headline.

var sb = require('./_lib/supabase');
var auth = require('./_lib/auth');

var PEXELS_KEY = process.env.PEXELS_API_KEY || '';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  var user = await auth.requireAdmin(req, res);
  if (!user) return;

  if (!PEXELS_KEY) return res.status(500).json({ error: 'PEXELS_API_KEY not configured' });

  var storyId = (req.body || {}).story_id || null;
  var customQuery = (req.body || {}).query || '';
  if (!storyId && !customQuery) return res.status(400).json({ error: 'query or story_id required' });

  // If we have a story_id, load it for context
  var story = null;
  if (storyId) {
    try {
      story = await sb.one('newsletter_stories?id=eq.' + storyId + '&select=id,headline,image_suggestion,image_url&limit=1');
    } catch (e) { /* non-fatal */ }
  }

  var searchTerms = customQuery || (story && story.image_suggestion) || (story && story.headline) || '';
  searchTerms = searchTerms.replace(/[^a-zA-Z0-9 ]/g, '').trim();
  if (!searchTerms) return res.status(400).json({ error: 'No search terms available' });

  try {
    // Get page 1-3 randomly to get variety
    var page = Math.floor(Math.random() * 3) + 1;
    var resp = await fetch('https://api.pexels.com/v1/search?query=' + encodeURIComponent(searchTerms) + '&per_page=5&page=' + page + '&orientation=landscape', {
      headers: { 'Authorization': PEXELS_KEY }
    });
    if (!resp.ok) return res.status(500).json({ error: 'Pexels API error: ' + resp.status });

    var data = await resp.json();
    if (!data.photos || data.photos.length === 0) {
      return res.status(404).json({ error: 'No images found for: ' + searchTerms });
    }

    // Pick a random photo from results (not always the first)
    var idx = Math.floor(Math.random() * data.photos.length);
    var photo = data.photos[idx];
    var baseUrl = photo.src.original.split('?')[0];
    var imageUrl = baseUrl + '?auto=compress&cs=tinysrgb&w=600&h=300&fit=crop';
    var imageAlt = photo.alt || searchTerms;

    // Update the story record if we have a story_id
    if (storyId) {
      try {
        await sb.mutate('newsletter_stories?id=eq.' + storyId, 'PATCH', {
          image_url: imageUrl,
          image_alt: imageAlt,
          updated_at: new Date().toISOString()
        });
      } catch (e) { /* non-fatal, image URL still returned */ }
    }

    return res.status(200).json({
      success: true,
      image_url: imageUrl,
      image_alt: imageAlt,
      search_query: searchTerms,
      page: page
    });
  } catch (e) {
    return res.status(500).json({ error: 'Image refresh failed: ' + e.message });
  }
};

