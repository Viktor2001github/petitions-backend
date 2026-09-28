const adminMiddleware = (req, res, next) => {
  // req.user передається з вашого authMiddleware
  if (!req.user || (req.user.role !== 'ADMIN')) {
    return res.status(403).json({ error: 'Доступ заборонено. Потрібні права адміна або модератора.' });
  }
  next();
};

module.exports = adminMiddleware;