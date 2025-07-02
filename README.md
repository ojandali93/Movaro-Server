# Movaro Server

A well-structured Node.js server with proper separation of concerns, built with Express.js and modern best practices.

## 🚀 Features

- **Modular Architecture**: Separated routes, controllers, and middleware
- **Security**: Helmet, CORS, rate limiting, and input validation
- **Error Handling**: Comprehensive error handling with custom middleware
- **Logging**: Structured logging with different levels
- **Validation**: Request validation using express-validator
- **API Documentation**: Ready for Swagger/OpenAPI integration
- **Testing**: Jest setup for unit and integration tests
- **Code Quality**: ESLint configuration for consistent code style

## 📁 Project Structure

```
├── server.js              # Server entry point
├── app.js                 # Express app configuration
├── package.json           # Dependencies and scripts
├── config/                # Configuration files
│   └── index.js          # Main configuration
├── routes/                # Route definitions
│   ├── index.js          # Main routes aggregator
│   ├── userRoutes.js     # User-related routes
│   └── authRoutes.js     # Authentication routes
├── controllers/           # Business logic
│   ├── userController.js # User operations
│   └── authController.js # Authentication operations
├── middleware/            # Custom middleware
│   ├── errorHandler.js   # Global error handling
│   ├── notFound.js       # 404 handler
│   ├── requestLogger.js  # Request logging
│   ├── asyncHandler.js   # Async error wrapper
│   └── validate.js       # Request validation
├── utils/                 # Utility functions
│   ├── response.js       # Standardized responses
│   └── logger.js         # Logging utilities
├── tests/                 # Test files (to be created)
├── .eslintrc.js          # ESLint configuration
├── env.example           # Environment variables example
└── README.md             # This file
```

## 🛠️ Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd Movaro-Server
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp env.example .env
   # Edit .env with your configuration
   ```

4. **Start the server**
   ```bash
   # Development mode
   npm run dev
   
   # Production mode
   npm start
   ```

## 📋 Available Scripts

- `npm start` - Start the server in production mode
- `npm run dev` - Start the server in development mode with nodemon
- `npm test` - Run tests
- `npm run lint` - Check code style
- `npm run lint:fix` - Fix code style issues

## 🔧 Configuration

The application uses environment variables for configuration. Copy `env.example` to `.env` and modify as needed:

```env
# Server Configuration
NODE_ENV=development
PORT=3000

# CORS Configuration
CORS_ORIGIN=*

# Database Configuration (for future use)
DATABASE_URL=
DB_HOST=localhost
DB_PORT=5432
DB_NAME=movaro_db
DB_USER=
DB_PASSWORD=

# JWT Configuration (for future use)
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production
JWT_EXPIRES_IN=24h

# Logging Configuration
LOG_LEVEL=info
LOG_ENABLED=true
```

## 🌐 API Endpoints

### Health Check
- `GET /health` - Server health status

### API Info
- `GET /api` - API information and version

### Authentication
- `POST /api/auth/register` - Register a new user
- `POST /api/auth/login` - Login user
- `POST /api/auth/logout` - Logout user
- `GET /api/auth/me` - Get current user

### Users
- `GET /api/users` - Get all users (with pagination and search)
- `GET /api/users/:id` - Get user by ID
- `POST /api/users` - Create new user
- `PUT /api/users/:id` - Update user
- `DELETE /api/users/:id` - Delete user

## 🔒 Security Features

- **Helmet**: Security headers
- **CORS**: Cross-origin resource sharing
- **Rate Limiting**: Prevents abuse
- **Input Validation**: Request data validation
- **Error Handling**: Secure error responses

## 📝 Request/Response Format

### Success Response
```json
{
  "success": true,
  "message": "Success message",
  "data": { ... },
  "timestamp": "2023-01-01T00:00:00.000Z"
}
```

### Error Response
```json
{
  "success": false,
  "error": "Error message",
  "timestamp": "2023-01-01T00:00:00.000Z"
}
```

### Paginated Response
```json
{
  "success": true,
  "message": "Success",
  "data": [ ... ],
  "pagination": {
    "currentPage": 1,
    "totalPages": 5,
    "totalItems": 50,
    "itemsPerPage": 10
  },
  "timestamp": "2023-01-01T00:00:00.000Z"
}
```

## 🧪 Testing

The project includes Jest for testing. Run tests with:

```bash
npm test
```

## 📊 Logging

The application uses structured logging with different levels:
- **ERROR**: Application errors
- **WARN**: Warning messages
- **INFO**: General information
- **DEBUG**: Debug information

Log level can be configured via `LOG_LEVEL` environment variable.

## 🔄 Middleware

### Built-in Middleware
- **Security**: Helmet, CORS
- **Performance**: Compression, rate limiting
- **Logging**: Morgan (dev), custom request logger
- **Parsing**: JSON, URL-encoded bodies

### Custom Middleware
- **Error Handler**: Global error handling
- **Not Found**: 404 handler
- **Request Logger**: Custom request logging
- **Async Handler**: Async error wrapper
- **Validation**: Request validation

## 🚀 Deployment

### Production Considerations
1. Set `NODE_ENV=production`
2. Configure proper CORS origins
3. Set secure JWT secrets
4. Configure database connections
5. Set up proper logging
6. Configure rate limiting
7. Set up monitoring and health checks

### Environment Variables for Production
```env
NODE_ENV=production
PORT=3000
CORS_ORIGIN=https://yourdomain.com
JWT_SECRET=your-super-secure-production-secret
LOG_LEVEL=warn
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Run linting: `npm run lint`
6. Run tests: `npm test`
7. Submit a pull request

## 📄 License

This project is licensed under the MIT License.

## 🆘 Support

For support and questions, please open an issue in the repository.
