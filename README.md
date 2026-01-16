# AppScroll Backend

A simple Express.js backend that proxies requests to Claude API for generating personalized AI insights.

## Setup

1. Clone this repository
2. Install dependencies: `npm install`
3. Set environment variable: `ANTHROPIC_API_KEY=your-key-here`
4. Run: `npm start`

## Deploy to Railway

1. Push this repo to GitHub
2. Go to [Railway](https://railway.app) and create a new project
3. Select "Deploy from GitHub repo"
4. Choose this repository
5. Add environment variable: `ANTHROPIC_API_KEY`
6. Railway will auto-detect and deploy

## API Endpoints

### POST /api/insight

Generate a personalized AI insight based on user behavior.

**Request Body:**
```json
{
  "recentSurfaces": ["Technology", "Finance", "Art"],
  "topInterests": ["Technology", "Space", "Music"],
  "sessionDuration": 15,
  "timeOfDay": "evening",
  "cardsViewed": 42
}
```

**Response:**
```json
{
  "title": "Your Evening Discovery Pattern",
  "content": "You seem drawn to the intersection of technology and creativity...",
  "category": "pattern",
  "tags": ["tech", "creativity", "evening"]
}
```

### GET /health

Health check endpoint.

## Environment Variables

- `ANTHROPIC_API_KEY` - Your Claude API key (required)
- `PORT` - Server port (default: 3000)
