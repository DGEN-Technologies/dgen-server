import { performanceMonitor } from "../lib/performance/PerformanceMonitor";

export default {
  async metrics(req, res) {
    try {
      const { user } = req;
      if (!user || user.username !== 'admin') {
        return res.code(403).send({ error: "Admin access required" });
      }

      const metrics = performanceMonitor.getMetrics();
      res.send(metrics);
    } catch (e) {
      res.code(500).send({ error: e.message });
    }
  }
};