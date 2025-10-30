import { createHash } from "crypto";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { err } from "./logging";
import { bail, fail } from "./utils";
import { fileTypeFromBuffer } from "file-type";

// Temporarily disable sharp - has issues with Bun runtime
let sharp: any = null;
// const sharp = require("sharp");

export default async (req, res) => {
  try {
    const {
      params: { type },
    } = req;

    const data = await req.file();
    let buf = await data.toBuffer();

    const [format, ext] = (await fileTypeFromBuffer(buf)).mime.split("/");

    if (format !== "image" && !["jpg", "jpeg", "png"].includes(ext))
      fail("unsupported file type");

    // Skip image processing if sharp is not available
    let processedBuf = buf;
    let fileExt = ext;
    
    if (sharp) {
      const w = type === "banner" ? 1920 : 240;
      processedBuf = await sharp(buf, { failOnError: false })
        .rotate()
        .resize(w)
        .webp()
        .toBuffer();
      fileExt = "webp";
    }

    const hash = createHash("sha256").update(processedBuf).digest("hex");

    // Ensure upload directory exists
    const uploadDir = join(process.cwd(), "data", "uploads");
    if (!existsSync(uploadDir)) {
      mkdirSync(uploadDir, { recursive: true });
    }

    const filePath = join(uploadDir, `${hash}.${fileExt}`);
    writeFileSync(filePath, processedBuf);

    res.send({ hash, ext: fileExt });
  } catch (e) {
    err("problem uploading", e.message);
    bail(res, e.message);
  }
};
