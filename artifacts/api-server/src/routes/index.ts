import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import paymentsRouter from "./payments";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(paymentsRouter);

export default router;
