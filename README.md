# Image URL Security Tester

A powerful tool to discover images on servers by testing variations of known-valid image URLs.

## Features

- 🔍 **URL Variation Testing**: Automatically generates and tests URL variations based on known valid URLs
- ⚡ **Concurrent Scanning**: Configurable concurrency for faster scanning
- 📊 **Real-time Statistics**: Track new images, placeholders, duplicates, and errors
- 🎯 **Smart Classification**: Automatically classifies discovered images
- 📥 **Export Results**: Download results as CSV for further analysis
- 🎨 **Modern UI**: Clean, responsive interface with dark theme

## Installation

```bash
npm install
```

## Usage

### Start the Server

```bash
npm start
```

The application will be available at `http://localhost:3000`

### Using the Web Interface

1. **Add Reference URLs**: Paste known-valid image URLs (one per line)
2. **Configure Settings**:
   - **Range**: Number of URL variations to generate (default: 50)
   - **Delay**: Milliseconds between request batches (default: 100ms)
   - **Concurrency**: Number of parallel requests (default: 5)
   - **Max Requests**: Maximum URLs to scan (default: 500)
3. **Start Scan**: Click "Start Scan" to begin
4. **Monitor Progress**: Watch real-time statistics and results
5. **Filter Results**: Show/hide different result types
6. **Export**: Download results as CSV when complete

## How It Works

1. The tool extracts numeric patterns from provided image URLs
2. It generates variations by incrementing these numbers
3. Each URL is tested with HEAD requests to verify existence
4. Results are classified as:
   - **New**: Previously unknown images
   - **Placeholder**: Small files (likely placeholders)
   - **Duplicate**: URLs matching reference URLs
   - **Error**: Non-existent or inaccessible URLs

## Configuration

- `PORT`: Server port (default: 3000)
- All scan parameters can be adjusted via the web UI

## Security Considerations

⚠️ **Important**: This tool should only be used on systems you have permission to scan. Unauthorized scanning may violate terms of service or local laws.

## Dependencies

- **Express.js**: Web server framework
- **Axios**: HTTP client for making requests
- **Node.js**: Runtime environment

## License

MIT
