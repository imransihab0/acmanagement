import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  /*
    Single-row table holding the passcode verifier. The passcode itself is
    never stored — only a PBKDF2-SHA256 derivation of it, with a per-install
    random salt. Changing the iteration count is safe: existing rows carry
    the count they were written with.
  */
  authConfig: defineTable({
    saltHex: v.string(),
    hashHex: v.string(),
    iterations: v.number(),
    updatedAt: v.number(),
  }),

  /*
    Issued sessions. The token handed to the browser is never stored either —
    only its SHA-256 hash, so a dump of this table cannot be replayed as a
    login.
  */
  sessions: defineTable({
    tokenHash: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_expiresAt", ["expiresAt"]),

  /*
    A customer order, as taken over WhatsApp.

    Items are embedded rather than a separate table: an order is always read
    and written whole, and embedding keeps the line items and the totals they
    produce in one atomic record.

    `unitCost` is snapshotted per line for the same reason sales snapshot it —
    so repricing a product later cannot rewrite the profit of an order that
    has already been fulfilled.
  */
  orders: defineTable({
    orderNo: v.string(),
    customerName: v.string(),
    customerPhone: v.optional(v.string()),
    customerAddress: v.optional(v.string()),
    orderedAt: v.number(),
    items: v.array(
      v.object({
        productId: v.id("products"),
        productName: v.string(),
        quantity: v.number(),
        unit: v.string(),
        unitPrice: v.number(),
        unitCost: v.number(),
        /*
          The purchase lot this line was sold from, when one was picked. The
          cost above is still the figure that counts — it is snapshotted the
          moment the sale is made — but the link is what lets the lot's
          remaining stock be put back if the sale is cancelled.
        */
        batchId: v.optional(v.id("stockBatches")),
        /*
          Which size/package this line sold, when the product has variants.
          The label is snapshotted alongside it — same reason `productName`
          is: renaming or removing the variant later must not reword a
          receipt that already went out.
        */
        variantId: v.optional(v.string()),
        variantLabel: v.optional(v.string()),
      }),
    ),
    subtotal: v.number(),
    discount: v.number(),
    deliveryCharge: v.number(),
    total: v.number(),
    paymentStatus: v.union(v.literal("paid"), v.literal("due"), v.literal("partial")),
    paidAmount: v.optional(v.number()),
    orderStatus: v.union(
      v.literal("pending"),
      v.literal("confirmed"),
      v.literal("delivered"),
      v.literal("cancelled"),
    ),
    note: v.optional(v.string()),
    /*
      The status a cancellation was made from, so undoing one puts the sale
      back where it was rather than guessing. A cancelled pending order and a
      cancelled confirmed order look identical afterwards — both are
      "cancelled" with no sales against them — and only one of them should
      take stock again when it is restored.
    */
    cancelledFrom: v.optional(
      v.union(v.literal("pending"), v.literal("confirmed"), v.literal("delivered")),
    ),
    /*
      Sales written when the order was confirmed. Confirming an order records
      one sale per line, so the Dashboard, Profit and Sales ledger keep working
      unchanged and include order revenue — without this, orders would be a
      second set of books the profit figures ignore.
    */
    saleIds: v.optional(v.array(v.id("sales"))),
    source: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_orderedAt", ["orderedAt"])
    .index("by_orderNo", ["orderNo"])
    .index("by_status", ["orderStatus"])
    .index("by_customerPhone", ["customerPhone"])
    .index("by_customerName", ["customerName"]),

  /** Monotonic counters, so order numbers never collide. */
  counters: defineTable({
    name: v.string(),
    value: v.number(),
  }).index("by_name", ["name"]),

  /*
    Who may sign in.

    An allowlist rather than a registration flow: this is a two-person shop,
    and the rows are meant to be edited in the Convex dashboard by hand. An
    address that is not here cannot ask for a code, so the sign-in screen has
    nothing to offer a stranger who reaches it.

    `email` is stored lowercased and trimmed, because Gmail treats addresses
    case-insensitively and an allowlist that does not would let one typo lock
    the owner out of their own shop.
  */
  loginEmails: defineTable({
    email: v.string(),
    /** Who it is, for whoever is reading the table later. */
    label: v.optional(v.string()),
    /*
      Kept rather than deleted when access is withdrawn, so the row that
      recorded someone's access is still there to be seen afterwards.
    */
    active: v.boolean(),
    createdAt: v.number(),
    lastLoginAt: v.optional(v.number()),
  }).index("by_email", ["email"]),

  /*
    A sign-in code, and the short-lived permission it becomes.

    The code itself is never stored — only a SHA-256 of it, for the same
    reason the passcode and session tokens are not kept in the clear: a dump
    of this table must not be replayable as a sign-in.

    `grantHash` appears once the code has been entered correctly, and is what
    opens the passcode step. Holding it server-side is the point: a client
    that simply enabled its own passcode field would be deciding its own
    authorisation, which is not a decision a browser gets to make.
  */
  otpChallenges: defineTable({
    email: v.string(),
    codeHash: v.string(),
    expiresAt: v.number(),
    /** Wrong codes entered against this challenge, so it cannot be ground down. */
    attempts: v.number(),
    grantHash: v.optional(v.string()),
    grantExpiresAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_email", ["email"])
    .index("by_grantHash", ["grantHash"])
    .index("by_expiresAt", ["expiresAt"]),

  /** Failed login timestamps, for throttling brute force. */
  loginFailures: defineTable({
    at: v.number(),
  }).index("by_at", ["at"]),

  /*
    Rows removed through an erase action are copied here first. Nothing in the
    app reads this table — it exists so a mistake is recoverable from the CLI,
    not so the interface can offer an undo. `batchId` groups one erase, which
    is the unit a restore works on.
  */
  archive: defineTable({
    table: v.string(),
    originalId: v.string(),
    data: v.any(),
    archivedAt: v.number(),
    batchId: v.string(),
    reason: v.string(),
  })
    .index("by_archivedAt", ["archivedAt"])
    .index("by_batch", ["batchId"]),

  /*
    A purchase lot ("ষ্টক"). Profit is always derived as
    (unitPrice - unitCost) * quantity rather than stored, so a lot can never
    disagree with its own arithmetic.
  */
  stockBatches: defineTable({
    productId: v.id("products"),
    productName: v.string(),
    label: v.string(),
    purchasedAt: v.number(),
    /** How many were bought. */
    quantity: v.number(),
    /*
      How many of them are left. Optional because lots recorded before this
      existed have never been drawn from — those fall back to the full
      quantity, which is exactly what they have left.
    */
    remaining: v.optional(v.number()),
    unitCost: v.number(),
    /*
      What one unit of this lot sells for. Every lot has one — a product has
      no price of its own any more (see stock.ts). Optional only for lots
      recorded before that, until `migrations:lotsOnly` fills them in.
    */
    unitPrice: v.optional(v.number()),
    note: v.optional(v.string()),
    /*
      Legacy: which product size this lot restocked, from when sizes lived
      on the product. A size is now just a lot of its own, named after it.
    */
    variantId: v.optional(v.string()),
    variantLabel: v.optional(v.string()),
    /** Who this lot was bought from. */
    vendorId: v.optional(v.id("vendors")),
    /*
      Receipts and other photos/videos for this specific purchase. These are
      references into `vendorMedia`, never a second copy of the file — the
      same upload can sit in the vendor's gallery and be linked from however
      many lots it is actually proof of.
    */
    mediaIds: v.optional(v.array(v.id("vendorMedia"))),
    /*
      True only for a lot logged through the Costs page's "Product purchase
      cost" tab rather than the ordinary "Add stock lot" flow on Products.
      Both write the same row — this just marks the ones that also moved the
      Investment counter, so removing one later knows to move it back.
    */
    investment: v.optional(v.boolean()),
    /*
      How much of this lot's cost has been paid to the vendor. Absent means
      fully paid — every lot recorded before this was tracked, and any lot
      with no vendor. The rest is what the shop still owes them.
    */
    vendorPaid: v.optional(v.number()),
    /*
      Set when the lot was taken off its product without being deleted —
      spoiled or lost stock. It stays in the vendor's purchase history; what
      was left in it (`writtenOff` units) was booked as a cost on that day.
    */
    removedAt: v.optional(v.number()),
    writtenOff: v.optional(v.number()),
  })
    .index("by_purchasedAt", ["purchasedAt"])
    .index("by_product", ["productId"])
    .index("by_vendor", ["vendorId"]),

  /*
    The categories vendors are filed under — the shop's own list, added to,
    renamed and removed from the Vendors page. `key` marks the five it
    started with, so vendors filed under the old fixed set find theirs.
  */
  vendorCategories: defineTable({
    name: v.string(),
    /** Shown instead of `name` in Bangla, when there is one. */
    nameBn: v.optional(v.string()),
    key: v.optional(v.string()),
    /** Parent category for hierarchical sub-categories */
    parentId: v.optional(v.id("vendorCategories")),
    order: v.number(),
    createdAt: v.number(),
  })
    .index("by_order", ["order"])
    .index("by_parent", ["parentId"]),

  /*
    A supplier — who the shop buys stock from, as distinct from `customers`,
    who buy from the shop. Filed under one of `vendorCategories`, which is
    what makes the Vendors page worth filtering by.
  */
  vendors: defineTable({
    name: v.string(),
    /** The vendor's profile picture, stored in Convex file storage or Cloudflare R2. */
    photoId: v.optional(v.id("_storage")),
    photoUrl: v.optional(v.string()),
    /** Absent when uncategorised — including after its category was deleted. */
    categoryId: v.optional(v.id("vendorCategories")),
    subCategoryId: v.optional(v.id("vendorCategories")),
    /*
      Legacy: the old fixed category, before categories could be edited.
      `migrations:vendorCategories` moves it to `categoryId`.
    */
    category: v.optional(
      v.union(
        v.literal("spawn"),
        v.literal("materials"),
        v.literal("equipment"),
        v.literal("packaging"),
        v.literal("other"),
      ),
    ),
    phone: v.optional(v.string()),
    /** Further numbers beyond the main one — a vendor is often reachable on more than one line. */
    extraPhones: v.optional(v.array(v.string())),
    whatsapp: v.optional(v.string()),
    facebookUrl: v.optional(v.string()),
    address: v.optional(v.string()),
    /** Tax Identification Number, typed in as text — the document photo (if any) lives in vendorMedia. */
    tin: v.optional(v.string()),
    tradeLicenseNo: v.optional(v.string()),
    note: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_categoryId", ["categoryId"])
    .index("by_createdAt", ["createdAt"]),

  /*
    A named folder inside one vendor's gallery — "TIN & Trade License",
    "Receipts", "Video", or anything the shop wants to call it. A few are
    created automatically with every new vendor; nothing stops adding more.
  */
  vendorFolders: defineTable({
    vendorId: v.id("vendors"),
    name: v.string(),
    createdAt: v.number(),
  }).index("by_vendor", ["vendorId"]),

  /*
    One uploaded file, filed under a vendor and (optionally) one of their
    folders. This is the single copy a lot's receipt photo and the vendor's
    own gallery both point at — a lot never gets its own copy of a file that
    already lives here, it only ever stores this row's id.
  */
  vendorMedia: defineTable({
    vendorId: v.id("vendors"),
    folderId: v.optional(v.id("vendorFolders")),
    storageId: v.optional(v.id("_storage")),
    url: v.optional(v.string()),
    kind: v.union(v.literal("image"), v.literal("video")),
    fileName: v.string(),
    createdAt: v.number(),
  })
    .index("by_vendor", ["vendorId"])
    .index("by_folder", ["folderId"]),

  /*
    How each taka of profit is divided. Percentages are validated to total
    100 on write, so the split can never silently lose or invent money.
  */
  allocationBuckets: defineTable({
    name: v.string(),
    nameBn: v.string(),
    percent: v.number(),
    order: v.number(),
  }).index("by_order", ["order"]),

  /*
    A cost the business carried that is not the price of stock — office
    snacks, van fuel, the electricity bill. Kept apart from `stockBatches`
    on purpose: a lot's cost is recovered when its units sell, and an
    operating cost never is. Mixing the two would make margin meaningless.
  */
  costs: defineTable({
    /*
      The name is copied onto the row rather than only referenced, for the
      same reason a sale snapshots its product name: renaming or deleting a
      saved name later must not rewrite what an old receipt said.
    */
    name: v.string(),
    /** Set when the name was picked from the saved list rather than typed. */
    costNameId: v.optional(v.id("costNames")),
    amount: v.number(),
    spentAt: v.number(),
    note: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_spentAt", ["spentAt"])
    .index("by_costName", ["costNameId"]),

  /*
    A cost name the shop expects to use again — "Office snacks", "Van fuel".
    Saving one is what stops the same expense being typed three ways and
    landing in a report as three separate things.

    `key` is the lowercased, space-collapsed name, so the check for "have we
    got this one already" is an index lookup rather than a scan that misses
    on a stray capital.
  */
  costNames: defineTable({
    name: v.string(),
    key: v.string(),
    /** How many costs have used it — the pick list is ordered by this. */
    usageCount: v.number(),
    lastUsedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_usage", ["usageCount"]),

  /*
    A fixed-cost folder — "Office Rent", "Staff Salary" — the recurring bills
    booked once a month rather than logged as they happen. Kept apart from
    `costNames`: those are suggestions for a free-typed one-off cost, these
    are the fixed set a month is actually filled in against.
  */
  fixedCostCategories: defineTable({
    name: v.string(),
    key: v.string(),
    createdAt: v.number(),
  }).index("by_key", ["key"]),

  /*
    One category's booked amount for one month — "Office Rent" for
    2026-10 was ৳15,000. A month with nothing entered yet for a category
    simply has no row, rather than a zero that looks like it was confirmed.
  */
  fixedCosts: defineTable({
    /** Local calendar month, "YYYY-MM" — a fixed cost is booked once a month, not on a day. */
    month: v.string(),
    categoryId: v.id("fixedCostCategories"),
    /** Snapshotted like a cost's name, so renaming or dropping the category later can't reword history. */
    categoryName: v.string(),
    amount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_month", ["month"])
    .index("by_month_category", ["month", "categoryId"])
    .index("by_category", ["categoryId"]),

  /*
    A customer the shop expects to see again. Saved from an order with the
    tick on, searched and picked the next time rather than retyped.

    Identity is the phone number when there is one — two people called Rifat
    are two customers, one phone number is one person — and the name only
    when there is not. A customer first saved without a phone and later with
    one therefore becomes two records; that is honest rather than clever,
    since merging them would mean guessing which Rifat placed which order.
  */
  customers: defineTable({
    name: v.string(),
    /** The customer's profile picture, stored in Convex file storage or Cloudflare R2. */
    photoId: v.optional(v.id("_storage")),
    photoUrl: v.optional(v.string()),
    phone: v.optional(v.string()),
    /** Further numbers beyond the main one — optional, as many as needed. */
    extraPhones: v.optional(v.array(v.string())),
    /*
      How you actually reach them. Kept apart from `phone` because the number
      that identifies a customer and the number you message are not always the
      same one, and because a shop that sells over WhatsApp needs the second
      even when it has the first.
    */
    whatsapp: v.optional(v.string()),
    facebookUrl: v.optional(v.string()),
    address: v.optional(v.string()),
    /** Digits of the phone, else the lowercased name. */
    key: v.string(),
    orderCount: v.number(),
    lastOrderedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_orders", ["orderCount"]),

  productCategories: defineTable({
    name: v.string(),
    nameBn: v.optional(v.string()),
    key: v.optional(v.string()),
    /** Parent category for hierarchical sub-categories */
    parentId: v.optional(v.id("productCategories")),
    order: v.number(),
    createdAt: v.number(),
  })
    .index("by_order", ["order"])
    .index("by_parent", ["parentId"]),

  products: defineTable({
    name: v.string(),
    /** The product's photo, stored in Convex file storage or Cloudflare R2. */
    photoId: v.optional(v.id("_storage")),
    photoUrl: v.optional(v.string()),
    /*
      Kept in step with the product's lots by `syncProduct` (stock.ts) — the
      cheapest buy and sell price among lots with stock left — and never set
      by hand. The lots are the truth; these are for screens that only need
      one figure.
    */
    costPrice: v.number(),
    sellPrice: v.optional(v.number()),
    /*
      What a "unit" means for this product — পিস, কেজি, গ্রাম, লিটার. Without
      it, stock totals add 2.5 kg of agar to 50 fogger nozzles.
    */
    unit: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    details: v.string(),
    category: v.optional(v.string()),
    subCategory: v.optional(v.string()),
    categoryId: v.optional(v.id("productCategories")),
    subCategoryId: v.optional(v.id("productCategories")),
    // Units currently on hand: what is left across all lots (see stock.ts).
    quantity: v.number(),
    /** Per-product low-stock threshold; falls back to a global default. */
    reorderLevel: v.optional(v.number()),
    /*
      Legacy: sizes used to live on the product. Each size is now a lot of its
      own, with its own prices, and `migrations:lotsOnly` clears these two.
      Kept optional only so the rows still validate until it has run.
    */
    variants: v.optional(
      v.array(
        v.object({
          /** Stable across edits — an order line points at this, not the array index. */
          id: v.string(),
          label: v.string(),
          costPrice: v.number(),
          sellPrice: v.optional(v.number()),
          /** This variant's own stock count — only set in "separate" mode. */
          quantity: v.optional(v.number()),
          /** How many base units (the product's `unit`/`quantity`) one of this variant is — only set in "shared" mode. */
          baseQuantity: v.optional(v.number()),
        }),
      ),
    ),
    stockMode: v.optional(v.union(v.literal("separate"), v.literal("shared"))),
    archived: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_archived", ["archived"]),

  sales: defineTable({
    productId: v.id("products"),
    /** The purchase lot this sale drew from, when one was picked. */
    batchId: v.optional(v.id("stockBatches")),
    // Name and cost are snapshotted so history stays correct if the
    // product is later renamed, repriced, or deleted.
    productName: v.string(),
    unitCost: v.number(),
    unitPrice: v.number(),
    quantity: v.number(),
    /** Which size/package this sale was, when the product has variants. */
    variantId: v.optional(v.string()),
    variantLabel: v.optional(v.string()),
    buyer: v.optional(v.string()),
    note: v.optional(v.string()),
    soldAt: v.number(),
  })
    .index("by_soldAt", ["soldAt"])
    .index("by_product", ["productId"]),

  /*
    Someone who has taken training at BD Mushroom. A profile, not a ledger
    entry: most fields are optional because a trainee is worth adding the
    moment training starts, before anyone has typed in an NID number or a
    blood group — the full picture fills in over time, through edits.
  */
  trainees: defineTable({
    name: v.string(),
    phone: v.optional(v.string()),
    photoId: v.optional(v.id("_storage")),
    fatherName: v.optional(v.string()),
    fatherPhone: v.optional(v.string()),
    motherName: v.optional(v.string()),
    motherPhone: v.optional(v.string()),
    bloodGroup: v.optional(v.string()),
    dateOfBirth: v.optional(v.number()),
    nationality: v.optional(v.string()),
    nidNumber: v.optional(v.string()),
    hometown: v.optional(v.string()),
    currentAddress: v.optional(v.string()),
    religion: v.optional(v.string()),
    /** Shown only when actually provided — none of these are required. */
    facebookUrl: v.optional(v.string()),
    whatsapp: v.optional(v.string()),
    youtubeUrl: v.optional(v.string()),
    twitterUrl: v.optional(v.string()),
    tiktokUrl: v.optional(v.string()),
    linkedinUrl: v.optional(v.string()),
    note: v.optional(v.string()),
    /** Set the first time a certificate is generated for this trainee. */
    certificateIssuedAt: v.optional(v.number()),
    /*
      The trainee's own login, handed to them at the office — there is no
      sign-up. Lowercased; the password is stored only as a PBKDF2 hash
      (see auth.ts), and both are absent until the shop sets them.
    */
    username: v.optional(v.string()),
    passwordHash: v.optional(v.string()),
    passwordSalt: v.optional(v.string()),
    /*
      A note for this trainee alone, shown in their portal — kept apart
      from `note`, which is the shop's private note and never leaves it.
    */
    portalNote: v.optional(v.string()),
    portalNoteUpdatedAt: v.optional(v.number()),
    /** Wrong passwords in a row, and when a run of them locks the login. */
    loginFailures: v.optional(v.number()),
    lockedUntil: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_username", ["username"]),

  /*
    A trainee's signed-in session — kept apart from `sessions`, the owner's,
    so a trainee's token can never pass `requireSession` and reach anything
    but their own courses.
  */
  traineeSessions: defineTable({
    traineeId: v.id("trainees"),
    tokenHash: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_trainee", ["traineeId"]),

  /*
    Small settings kept by name. "traineeNote" is the note every trainee
    sees in their portal.
  */
  appSettings: defineTable({
    key: v.string(),
    text: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  /* A course the shop teaches — lessons in order, assigned to trainees. */
  courses: defineTable({
    name: v.string(),
    description: v.optional(v.string()),
    order: v.number(),
    createdAt: v.number(),
  }).index("by_order", ["order"]),

  courseLessons: defineTable({
    courseId: v.id("courses"),
    title: v.string(),
    /** Plain text, shown as written. */
    body: v.optional(v.string()),
    /** A YouTube link, embedded on the lesson. */
    videoUrl: v.optional(v.string()),
    files: v.optional(
      v.array(
        v.object({
          storageId: v.id("_storage"),
          fileName: v.string(),
          kind: v.union(v.literal("image"), v.literal("pdf")),
        }),
      ),
    ),
    order: v.number(),
    createdAt: v.number(),
  }).index("by_course", ["courseId"]),

  /*
    A course assigned to a trainee. The certificate for it is the shop's to
    approve once every lesson is done; only then can the trainee download it.
  */
  enrollments: defineTable({
    traineeId: v.id("trainees"),
    courseId: v.id("courses"),
    assignedAt: v.number(),
    certificateApprovedAt: v.optional(v.number()),
    /*
      A final exam or practical, marked by the shop outside the app. Counts
      toward the course score alongside the assignments; absent if there was
      none.
    */
    finalMarks: v.optional(v.number()),
    finalMax: v.optional(v.number()),
  })
    .index("by_trainee", ["traineeId"])
    .index("by_course", ["courseId"]),

  /*
    Work a course sets — the trainee hands it in from the portal (a YouTube
    link to their own video, a note, photos or PDFs) and the shop marks it
    out of `maxMarks`. Trainees only ever see the grade, never the number.
  */
  assignments: defineTable({
    courseId: v.id("courses"),
    title: v.string(),
    instructions: v.optional(v.string()),
    maxMarks: v.number(),
    dueAt: v.optional(v.number()),
    order: v.number(),
    createdAt: v.number(),
  }).index("by_course", ["courseId"]),

  submissions: defineTable({
    assignmentId: v.id("assignments"),
    courseId: v.id("courses"),
    traineeId: v.id("trainees"),
    videoUrl: v.optional(v.string()),
    note: v.optional(v.string()),
    files: v.optional(
      v.array(
        v.object({
          storageId: v.id("_storage"),
          fileName: v.string(),
          kind: v.union(v.literal("image"), v.literal("pdf")),
        }),
      ),
    ),
    submittedAt: v.number(),
    /** Set by the shop; the trainee sees only the grade it makes. */
    marks: v.optional(v.number()),
    feedback: v.optional(v.string()),
    gradedAt: v.optional(v.number()),
  })
    .index("by_trainee", ["traineeId"])
    .index("by_assignment", ["assignmentId"]),

  /** One lesson a trainee has finished. Its absence means not done yet. */
  lessonProgress: defineTable({
    traineeId: v.id("trainees"),
    courseId: v.id("courses"),
    lessonId: v.id("courseLessons"),
    completedAt: v.number(),
  })
    .index("by_trainee", ["traineeId"])
    .index("by_trainee_lesson", ["traineeId", "lessonId"])
    .index("by_lesson", ["lessonId"]),

  /*
    One lesson allocated to one trainee. Per-trainee rather than a shared
    curriculum, because "every lesson allocated to them" (the condition for a
    certificate) only means something if different trainees can be allocated
    different lessons.
  */
  traineeLessons: defineTable({
    traineeId: v.id("trainees"),
    name: v.string(),
    completed: v.boolean(),
    completedAt: v.optional(v.number()),
    /** Allocation order, so the checklist reads in the order lessons were added. */
    order: v.number(),
    createdAt: v.number(),
  }).index("by_trainee", ["traineeId"]),

  /*
    A trainee's gallery — class photos, mostly, kept as proof training
    actually happened. Flat rather than foldered like a vendor's: there is no
    equivalent of a vendor's TIN/trade-license/receipts split here, just
    photos of one person's classes.
  */
  traineeMedia: defineTable({
    traineeId: v.id("trainees"),
    storageId: v.id("_storage"),
    kind: v.union(v.literal("image"), v.literal("video")),
    fileName: v.string(),
    createdAt: v.number(),
  }).index("by_trainee", ["traineeId"]),
});
