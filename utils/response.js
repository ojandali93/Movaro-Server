/**
 * Utility functions for standardized API responses
 */

const successResponse = (res, data, message = 'Success', statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
    timestamp: new Date().toISOString()
  });
};

const errorResponse = (res, error, statusCode = 500) => {
  return res.status(statusCode).json({
    success: false,
    error: error.message || error,
    timestamp: new Date().toISOString()
  });
};

const paginatedResponse = (res, data, pagination, message = 'Success') => {
  return res.json({
    success: true,
    message,
    data,
    pagination,
    timestamp: new Date().toISOString()
  });
};

module.exports = {
  successResponse,
  errorResponse,
  paginatedResponse
}; 