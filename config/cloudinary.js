const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const { Readable } = require("stream");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const memoryStorage = multer.memoryStorage();

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const ALLOWED_FILE_TYPES = ["application/pdf"];

function makeImageUpload() {
  return multer({
    storage: memoryStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter(req, file, cb) {
      if (ALLOWED_IMAGE_TYPES.includes(file.mimetype)) return cb(null, true);
      cb(new Error("نوع الملف غير مسموح"));
    },
  });
}

function makeFileUpload() {
  return multer({
    storage: memoryStorage,
    limits: { fileSize: 20 * 1024 * 1024 },
    fileFilter(req, file, cb) {
      if (ALLOWED_FILE_TYPES.includes(file.mimetype)) return cb(null, true);
      cb(new Error("نوع الملف غير مسموح، يُسمح فقط بـ PDF"));
    },
  });
}

function uploadToCloudinary(buffer, folder, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, ...options },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    Readable.from(buffer).pipe(stream);
  });
}

async function deleteFromCloudinary(url, resource_type = "image") {
  if (!url || !url.includes("cloudinary.com")) return;
  try {
    const parts = url.split("/");
    const uploadIndex = parts.indexOf("upload");
    let pathParts = parts.slice(uploadIndex + 1);
    if (/^v\d+$/.test(pathParts[0])) pathParts = pathParts.slice(1);
    const publicId = pathParts.join("/").replace(/\.[^/.]+$/, "");
    await cloudinary.uploader.destroy(publicId, { resource_type });
  } catch {
    console.error("Cloudinary delete error");
  }
}

module.exports = { cloudinary, makeImageUpload, makeFileUpload, uploadToCloudinary, deleteFromCloudinary };
