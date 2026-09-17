/**
 * Standardized API Response Utilities
 */

function success(res, data = {}, message = 'Success', statusCode = 200) {
    return res.status(statusCode).json({
        success: true,
        message,
        data,
        timestamp: new Date().toISOString()
    });
}

function error(res, message = 'An error occurred', statusCode = 400, errors = null) {
    const payload = {
        success: false,
        error: message,
        timestamp: new Date().toISOString()
    };

    if (errors) {
        payload.details = errors;
    }

    return res.status(statusCode).json(payload);
}

module.exports = {
    success,
    error
};
