import { DocumentAsset } from "../model/documentAsset.model.js";
import { StorageObject } from "../model/storageObject.model.js";
import { putPrivateFile, getPrivateFileStream } from "../services/storage/storage.service.js";

const ALLOWED_ENTITY_TYPES = new Set([
  "product",
  "customer",
  "user",
  "transporter",
  "purchase_invoice",
  "sales_invoice",
  "other",
]);

export const uploadDocumentAsset = async (req, res) => {
  try {
    const { database, entityType, entityId, documentType, uploadedBy } = req.body;
    if (!database || !entityType || !entityId || !documentType) {
      return res.status(400).json({
        status: false,
        message: "database, entityType, entityId and documentType are required",
      });
    }
    if (!ALLOWED_ENTITY_TYPES.has(String(entityType))) {
      return res.status(400).json({ status: false, message: "Invalid entityType" });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({ status: false, message: "file is required" });
    }

    const previous = await DocumentAsset.find({
      database,
      entityType,
      entityId,
      documentType,
      current: true,
      status: "active",
    }).sort({ version: -1 });

    const version = Number(previous[0]?.version || 0) + 1;
    if (previous.length) {
      await DocumentAsset.updateMany(
        { _id: { $in: previous.map((x) => x._id) } },
        { current: false },
      );
    }

    const stored = await putPrivateFile({
      database,
      entityType,
      entityId,
      documentType,
      buffer: req.file.buffer,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
    });

    const asset = await DocumentAsset.create({
      database,
      entityType,
      entityId,
      documentType,
      version,
      current: true,
      storageObjectId: stored.storageObjectId,
      provider: stored.provider,
      fileId: stored.fileId || "",
      storageKey: stored.storageKey || "",
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size || req.file.buffer.length,
      checksum: stored.checksum,
      uploadedBy: req.rupioAuth?.id || uploadedBy || "",
    });

    return res.status(201).json({
      status: true,
      Document: asset,
      replicationStatus: stored.replicationStatus,
      copies: stored.copies,
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

export const listDocumentAssets = async (req, res) => {
  try {
    const docs = await DocumentAsset.find({
      database: req.params.database,
      entityType: req.params.entityType,
      entityId: req.params.entityId,
      status: { $ne: "deleted" },
    })
      .sort({ documentType: 1, version: -1 })
      .lean();

    const objectIds = docs.map((d) => d.storageObjectId).filter(Boolean);
    const objects = await StorageObject.find({ _id: { $in: objectIds } })
      .select("_id replicationStatus copies checksum")
      .lean();
    const objectMap = new Map(objects.map((o) => [String(o._id), o]));

    return res.json({
      status: true,
      Documents: docs.map((d) => ({
        ...d,
        storage: d.storageObjectId
          ? objectMap.get(String(d.storageObjectId)) || null
          : null,
      })),
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

export const downloadDocumentAsset = async (req, res) => {
  try {
    const asset = await DocumentAsset.findById(req.params.id).lean();
    if (!asset || asset.status === "deleted") {
      return res.status(404).json({ status: false, message: "Document not found" });
    }
    if (
      !req.rupioAuth?.isMaster &&
      String(asset.database) !== String(req.rupioAuth?.database || "")
    ) {
      return res.status(403).json({ status: false, message: "Access denied" });
    }

    const { stream } = await getPrivateFileStream(asset);
    res.setHeader("Content-Type", asset.mimeType || "application/octet-stream");
    res.setHeader(
      "Content-Disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(asset.fileName)}`,
    );
    return stream.pipe(res);
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

export const requestDocumentDeletion = async (req, res) => {
  try {
    const asset = await DocumentAsset.findById(req.params.id);
    if (!asset) {
      return res.status(404).json({ status: false, message: "Document not found" });
    }
    if (
      !req.rupioAuth?.isMaster &&
      String(asset.database) !== String(req.rupioAuth?.database || "")
    ) {
      return res.status(403).json({ status: false, message: "Access denied" });
    }

    const now = new Date();
    asset.status = "deletion_requested";
    asset.deletionRequestedAt = now;
    asset.deleteAfter = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    await asset.save();
    return res.json({
      status: true,
      message: "Deletion protected: document moved to 30-day recovery state",
      Document: asset,
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

export const restoreDocumentAsset = async (req, res) => {
  try {
    const asset = await DocumentAsset.findById(req.params.id);
    if (!asset) {
      return res.status(404).json({ status: false, message: "Document not found" });
    }
    if (
      !req.rupioAuth?.isMaster &&
      String(asset.database) !== String(req.rupioAuth?.database || "")
    ) {
      return res.status(403).json({ status: false, message: "Access denied" });
    }

    asset.status = "active";
    asset.deletionRequestedAt = undefined;
    asset.deleteAfter = undefined;
    await asset.save();
    return res.json({ status: true, Document: asset });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};
