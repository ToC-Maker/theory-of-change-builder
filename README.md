# Theory of Change Graph Builder

An interactive web application for creating and sharing Theory of Change diagrams with persistent URLs and collaborative editing.

## Features

- 📊 Interactive drag-and-drop graph creation
- 🔗 Shareable URLs with view/edit permissions
- 💾 Automatic cloud saving
- 📱 Responsive design
- ⚡ Real-time collaboration ready

## Quick Start

### Development
```bash
npm install
npm run dev
```

### Production Deploy (Netlify)
```bash
npm run build
```

## Environment Setup

### Required Environment Variables
Add these to your `.env.local` for development and Netlify environment for production:

```env
DATABASE_URL=your-neon-postgresql-connection-string
```

### Database Setup
1. Create a [Neon](https://neon.tech) PostgreSQL database
2. Run the schema creation (table will be auto-created on first use)
3. Add your DATABASE_URL to environment variables

## Architecture

- **Frontend**: React + TypeScript + Vite
- **Backend**: Netlify Functions (serverless)
- **Database**: PostgreSQL (Neon)
- **Deployment**: Netlify

## API Endpoints

- `POST /.netlify/functions/createChart` - Create new chart
- `GET /.netlify/functions/getChart` - Fetch chart by ID or edit token
- `POST /.netlify/functions/updateChart` - Update existing chart

## URL Structure

- `/` - Create new chart
- `/chart/{id}` - View chart (read-only)
- `/edit/{token}` - Edit chart (full permissions)

## Local Testing

```bash
# With Netlify Dev (recommended)
npm install -g netlify-cli
netlify dev

# App will be available at http://localhost:8888
```
