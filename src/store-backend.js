window.indexedDB = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
window.IDBTransaction = window.IDBTransaction || window.webkitIDBTransaction || window.msIDBTransaction;
window.IDBKeyRange = window.IDBKeyRange || window.webkitIDBKeyRange || window.msIDBKeyRange;

var STORE_DB_VERSION = 2;

/**
 * Puts all the data in multiple files seperated by offsets, to
 * alleviate lack of sparse files.
 */
function StoreBackend(basename, existingCb) {
    this.key = function(offset) {
	offset = offset.toString(16);
	while(offset.length < 16)
	    offset = "0" + offset;
	return basename + "." + offset;
    };

    var req = indexedDB.open("bitford-store", STORE_DB_VERSION);
    req.onerror = function() {
	console.error("indexedDB", arguments);
    };
    this.onOpenCbs = [];
    req.onupgradeneeded = function(event) {
	var db = event.target.result;
	var objectStore = db.createObjectStore('chunks');
    };
    req.onsuccess = function(event) {
	this.db = event.target.result;
	if (!this.db)
	    throw "No DB";

	/* Recover pre-existing chunks from last session */
	this.existingCb = existingCb;
	this.recover();
	var onOpenCbs = this.onOpenCbs;
	delete this.onOpenCbs;
	onOpenCbs.forEach(function(cb) {
	    cb();
	});
    }.bind(this);

    this.remove = function() {
	this.transaction("readwrite", function(objectStore) {
	    var req = objectStore.openCursor(
		IDBKeyRange.lowerBound(this.key(0)),
		'next'
	    );
	    req.onsuccess = function(event) {
		var cursor = event.target.result;
		if (cursor && cursor.key.indexOf(basename + ".") === 0) {
		    objectStore.delete(cursor.key);
		    cursor.continue();
		}
	    };
	    req.onerror = function(e) {
		console.error("cursor", e);
	    };
	}.bind(this));
    };
}

StoreBackend.prototype = {
    recover: function() {
	this.transaction("readonly", function(objectStore) {
	    var req = objectStore.openCursor(
		IDBKeyRange.lowerBound(this.key(0)),
		'next'
	    );
	    req.onsuccess = function(event) {
		var cursor = event.target.result;
		if (cursor && cursor.key.indexOf(this.basename + ".") === 0) {
		    var offset = parseInt(cursor.key.slice(this.basename.length + 1), 16);
		    this.existingCb(offset, cursor.value.byteLength);
		    cursor.continue();
		}
	    }.bind(this);
	    req.onerror = function(e) {
		console.error("cursor", e);
	    };
	}.bind(this));
    },

    /**
     * mode :: "readonly" or "readwrite"
     */
    transaction: function(mode, cb, finalCb) {
	if (this.db) {
	    var tx = this.db.transaction(['chunks'], mode);
	    tx.onerror = function(e) {
		console.error("store tx", e);
		if (finalCb)
		    finalCb(e);
	    };
	    tx.oncomplete = function() {
		if (finalCb)
		    finalCb();
	    };
	    cb(tx.objectStore('chunks'));
	} else {
	    this.onOpenCbs.push(function() {
		this.transaction(mode, cb, finalCb);
	    }.bind(this));
	}
    },

    readFrom: function(offset, cb) {
	this.transaction("readonly", function(objectStore) {
	    var req = objectStore.get(this.key(offset));
	    req.onsuccess = function(event) {
		var data = req.result;
		if (data) {
		    cb(req.result);
		} else {
		    /* TODO: reads for pieces are not neccessarily
		     * aligned with our CHUNK_LENGTH */
		    console.error("store readFrom offset too low", offset);
		    cb();
		}
	    }.bind(this);
	    req.onerror = function(e) {
		console.error("store read", offset, e);
		cb();
	    };
	}.bind(this));
    },

    read: function(offset, length, cb) {
	var result = new BufferList();

	var readFrom = function(offset, remain) {
	    if (remain < 1) {
		if (remain < 0)
		    result.take(-result);
		return cb(result);
	    }

	    this.readFrom(offset, function(data) {
		var len = data ? data.byteLength : 0;
		if (len > 0) {
		    result.append(data);
		    readFrom(offset + len, remain - len);
		} else {
		    console.error("Read", len, "instead of", remain, "from", offset);
		    return cb(result);
		}
	    });
	}.bind(this);
	readFrom(offset, length);
    },

    write: function(offset, data, cb) {
	data.readAsArrayBuffer(function(buf) {
	    this.transaction("readwrite", function(objectStore) {
		objectStore.put(buf, this.key(offset));
	    }.bind(this), cb);
	}.bind(this));
    }
};


function reclaimStorage(activeInfoHashes, finalCb) {
    var active = {};
    console.log("activeInfoHashes", activeInfoHashes);
    activeInfoHashes.forEach(function(infoHash) {
	active[bufferToHex(infoHash)] = true;
    });
    console.log("active", active);

    var req = indexedDB.open("bitford-store", STORE_DB_VERSION);
    req.onupgradeneeded = function(event) {
	var db = event.target.result;
	var objectStore = db.createObjectStore('chunks');
    };
    req.onsuccess = function(event) {
	var db = event.target.result;
	if (!db)
	    return;

	var tx = db.transaction(['chunks'], "readwrite");
	var totalReclaimed = 0;
	tx.oncomplete = function() {
	    finalCb(totalReclaimed);
	};

	var objectStore = tx.objectStore('chunks');
	var req = objectStore.openCursor(
	    IDBKeyRange.lowerBound(""),
	    'next'
	);
	req.onsuccess = function(event) {
	    var cursor = event.target.result;
	    if (cursor && cursor.key) {
		var infoHashHex = cursor.key.slice(0, 40);
		if (!active.hasOwnProperty(infoHashHex)) {
		    objectStore.delete(cursor.key);
		    totalReclaimed += cursor.value.byteLength;
		}
		cursor.continue();
	    }
	}
    };
}
