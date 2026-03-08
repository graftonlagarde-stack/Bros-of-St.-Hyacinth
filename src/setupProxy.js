const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function(app) {
  app.use(
    '/cloudinary-upload',
    createProxyMiddleware({
      target: 'https://api.cloudinary.com',
      changeOrigin: true,
      pathRewrite: { '^/cloudinary-upload': '' },
      on: {
        proxyReq: (proxyReq, req) => {
          proxyReq.path = req.url.replace('/cloudinary-upload', '');
        },
      },
    })
  );
};
