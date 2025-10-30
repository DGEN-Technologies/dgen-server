import { getConfig } from "./config-loader";
import { fail, getUser } from "./utils";
import fastifyPassport from "@fastify/passport";
import jwt from "passport-jwt";

export const admin = {
  preValidation: (fastifyPassport as any).authenticate(
    "jwt",
    { session: false },
    (req: any, res: any, user: any) => {
      if (!user?.admin) return res.code(401).send("unauthorized");
      req.user = user;
    },
  ),
};

export const optional = {
  preValidation: (fastifyPassport as any).authenticate(
    "jwt",
    { session: false },
    (req: any, user: any) => {
      req.user = user;
    },
  ),
};

export const auth = {
  preValidation: (fastifyPassport as any).authenticate("jwt", {
    authInfo: false,
    session: false,
  }),
};

export const requirePin = async ({ body, user }) => {
  if (!user || (user.pin && user.pin !== body.pin)) fail("Invalid pin");
};

export const jwtStrategy = new jwt.Strategy(
  {
    jwtFromRequest: jwt.ExtractJwt.fromExtractors([
      jwt.ExtractJwt.fromAuthHeaderAsBearerToken(),
      (req) => (req.cookies ? req.cookies.token : null),
    ]),
    secretOrKey: getConfig().jwt,
  },
  async (payload, next) => {
    const user = await getUser(payload.id);
    next(null, user);
  },
);
