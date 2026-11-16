// Test-only plugin: asks for a low start when a request carries x-test-network: slow.
export default {
  getStartQualityCap: req => (req.get('x-test-network') === 'slow' ? 'low' : null),
};
