import { Product } from "../model/product.model.js";

const isTrue = (v) =>
  v === true || String(v).toLowerCase() === "true" || v === 1 || v === "1";

const legacyUrl = (name) =>
  name ? `/Images/${String(name).replace(/^\/+/, "")}` : "";

const activeImages = (product) =>
  Array.isArray(product?.productImages)
    ? product.productImages.filter((x) => x?.status !== "deleted")
    : [];

const hasImage = (product) =>
  activeImages(product).some((x) => x?.appUrl || x?.detailUrl) ||
  (Array.isArray(product?.Product_image) && product.Product_image.some(Boolean));

const normalizeProductForApp = (p) => {
  const images = activeImages(p);
  const legacy = Array.isArray(p?.Product_image)
    ? p.Product_image.filter(Boolean)
    : [];
  const primary = images.find((x) => x.isPrimary) || images[0];
  const primaryImageUrl =
    primary?.appUrl ||
    primary?.detailUrl ||
    p?.primaryImageUrl ||
    legacyUrl(legacy[0]);

  return {
    _id: p?._id,
    id: p?.id || "",
    sId: p?.sId || "",
    database: p?.database || "",
    Product_Title: p?.Product_Title || "",
    Product_Desc: p?.Product_Desc || "",
    category: p?.category || "",
    SubCategory: p?.SubCategory || "",
    productSection: p?.productSection || "",
    HSN_Code: p?.HSN_Code || "",
    GSTRate: p?.GSTRate ?? p?.gstPercentage ?? "",
    gstPercentage: p?.gstPercentage ?? p?.GSTRate ?? "",
    primaryUnit: p?.primaryUnit || "",
    secondaryUnit: p?.secondaryUnit || "",
    secondarySize: p?.secondarySize ?? "",
    Size: p?.Size ?? "",
    Product_MRP: p?.Product_MRP ?? 0,
    SalesRate: p?.SalesRate ?? p?.saleRate ?? 0,
    saleRate: p?.saleRate ?? p?.SalesRate ?? 0,
    qty: p?.qty ?? 0,
    status: p?.status || "",
    productImages: images.map((x) => ({
      imageId: x.imageId,
      isPrimary: Boolean(x.isPrimary),
      thumbnailUrl: x.thumbnailUrl || "",
      appUrl: x.appUrl || "",
      detailUrl: x.detailUrl || "",
      status: x.status || "ready",
    })),
    Product_image: legacy,
    primaryImageUrl,
    thumbnailUrl: primary?.thumbnailUrl || primaryImageUrl,
    appImageUrl: primary?.appUrl || primaryImageUrl,
    detailImageUrl: primary?.detailUrl || primaryImageUrl,
    imageReady: Boolean(p?.imageReady || primaryImageUrl),
    customerAppPublished: Boolean(p?.customerAppPublished),
    salesAppPublished: Boolean(p?.salesAppPublished),
  };
};

const verifyProductCompany = (product, req, res) => {
  const allowed = String(req.rupioAuth?.database || "");
  if (!allowed || String(product?.database || "") !== allowed) {
    res.status(403).json({
      status: false,
      message: "This product does not belong to the logged-in company",
    });
    return false;
  }
  return true;
};

export const updateProductPublishing = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product)
      return res.status(404).json({ status: false, message: "Product not found" });
    if (!verifyProductCompany(product, req, res)) return;

    const customer = isTrue(req.body.customerAppPublished);
    const sales = isTrue(req.body.salesAppPublished);
    if ((customer || sales) && !hasImage(product)) {
      return res.status(400).json({
        status: false,
        code: "PRODUCT_IMAGE_REQUIRED",
        message:
          "Upload at least one product image before publishing to Customer App or Sales App",
      });
    }

    product.customerAppPublished = customer;
    product.salesAppPublished = sales;
    product.imageReady = hasImage(product);
    await product.save();
    return res.json({
      status: true,
      Product: normalizeProductForApp(product.toObject()),
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

export const setPrimaryProductImage = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product)
      return res.status(404).json({ status: false, message: "Product not found" });
    if (!verifyProductCompany(product, req, res)) return;

    let found = false;
    product.productImages = (product.productImages || []).map((img) => {
      const match =
        img.imageId === req.params.imageId && img.status !== "deleted";
      if (match) found = true;
      img.isPrimary = match;
      return img;
    });
    if (!found)
      return res.status(404).json({ status: false, message: "Image not found" });

    const primary = product.productImages.find((x) => x.isPrimary);
    product.primaryImageUrl = primary?.appUrl || primary?.detailUrl || "";
    await product.save();
    return res.json({
      status: true,
      Product: normalizeProductForApp(product.toObject()),
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

export const deleteProductImage = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product)
      return res.status(404).json({ status: false, message: "Product not found" });
    if (!verifyProductCompany(product, req, res)) return;

    const image = (product.productImages || []).find(
      (x) => x.imageId === req.params.imageId,
    );
    if (!image)
      return res.status(404).json({ status: false, message: "Image not found" });

    image.status = "deleted";
    image.isPrimary = false;
    const active = (product.productImages || []).filter(
      (x) => x.status !== "deleted",
    );
    if (active.length && !active.some((x) => x.isPrimary)) {
      active[0].isPrimary = true;
    }
    const primary = active.find((x) => x.isPrimary) || active[0];
    product.primaryImageUrl = primary?.appUrl || primary?.detailUrl || "";
    product.imageReady =
      active.length > 0 || (product.Product_image || []).length > 0;

    if (!product.imageReady) {
      product.customerAppPublished = false;
      product.salesAppPublished = false;
    }

    if (image.legacyFilename) {
      product.Product_image = (product.Product_image || []).filter(
        (x) => String(x) !== String(image.legacyFilename),
      );
    }

    await product.save();
    return res.json({
      status: true,
      Product: normalizeProductForApp(product.toObject()),
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

export const getPublishedCatalog = async (req, res) => {
  try {
    const channel = String(req.query.channel || "customer").toLowerCase();
    if (!new Set(["customer", "sales"]).has(channel)) {
      return res.status(400).json({ status: false, message: "Invalid catalog channel" });
    }

    const field =
      channel === "sales" ? "salesAppPublished" : "customerAppPublished";

    const products = await Product.find({
      database: req.params.database,
      status: "Active",
      imageReady: true,
      [field]: true,
    })
      .select(
        "_id id sId database Product_Title Product_Desc category SubCategory productSection HSN_Code GSTRate gstPercentage primaryUnit secondaryUnit secondarySize Size Product_MRP SalesRate saleRate qty status productImages Product_image primaryImageUrl imageReady customerAppPublished salesAppPublished",
      )
      .sort({ category: 1, SubCategory: 1, Product_Title: 1 })
      .lean();

    return res.json({
      status: true,
      channel,
      Product: products.map(normalizeProductForApp),
    });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};

export const backfillLegacyProductImages = async (req, res) => {
  try {
    const products = await Product.find({
      database: req.params.database,
      status: "Active",
    });
    let updated = 0;

    for (const product of products) {
      if (
        (product.productImages || []).length ||
        !(product.Product_image || []).length
      ) {
        continue;
      }

      const names = product.Product_image.filter(Boolean);
      product.productImages = names.map((name, index) => ({
        imageId: `legacy-${product._id}-${index}`,
        isPrimary: index === 0,
        originalProvider: "legacy",
        originalName: String(name),
        thumbnailUrl: legacyUrl(name),
        appUrl: legacyUrl(name),
        detailUrl: legacyUrl(name),
        legacyFilename: String(name),
        status: "ready",
      }));
      product.primaryImageUrl = legacyUrl(names[0]);
      product.imageReady = true;

      const raw = String(product.productSection || "").toUpperCase();
      const visible = raw !== "RAW_MATERIAL" && raw !== "RAW MATERIAL";
      product.customerAppPublished = visible;
      product.salesAppPublished = visible;
      await product.save();
      updated += 1;
    }

    return res.json({ status: true, updated });
  } catch (error) {
    return res.status(500).json({ status: false, message: error.message });
  }
};
