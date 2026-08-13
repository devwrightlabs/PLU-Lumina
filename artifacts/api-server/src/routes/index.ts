import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import paymentsRouter from "./payments";
import usersRouter from "./users";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

router.use(healthRouter);

router.use("/v1", (req, res, next) => {
  if (req.method === "POST" && req.path === "/auth/pi") {
    next();
    return;
  }
  requireAuth(req, res, next);
});

router.use(authRouter);
router.use(paymentsRouter);
router.use(usersRouter);

export default router;
