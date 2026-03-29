# WorldGen - builds the race world at runtime from Kenney 3D Road Tile assets.
#
# Road layout (top-down):
#   NW corner --- North straight --- NE corner
#   |                                        |
#   West straight   (island interior)   East straight
#   |                                        |
#   SW corner --- South straight --- SE corner
#
# - Sea base    : large blue plane at y = 0
# - Shore ring  : Kenney water tiles, 3 rows deep around island
# - Island      : green StaticBody3D box, top at y = 2.0
# - Road loop   : Kenney road tiles on a 3x3 grid per segment
#                 Collision from invisible StaticBody3D boxes underneath
# - Obstacles   : Geodesic dome GLBs, added to "obstacle" group
#
# Lighting / sky are handled in the scene, not here.
extends Node3D

# ── Asset paths (Godot auto-imports on first editor open) ──────────────────────
const STRAIGHT_PATH := "res://assets/road_straight.gltf"   # tile_075: asphalt + white markings
const CORNER_PATH   := "res://assets/road_corner.gltf"     # tile_059: plain asphalt
const SEA_TILE_PATH := "res://assets/sea_tile.gltf"        # tile_001: water surface
const DOME_PATH     := "res://assets/geodesic_dome.glb"

# ── World constants ────────────────────────────────────────────────────────────
const TILE_SIZE   := 3.0    # all Kenney road tiles are 3 × 3 units
const ROAD_TILES  := 3      # tiles wide per road section -> 9 units total
const LOOP_R      := 60.0   # road centreline distance from world centre
const ISLAND_HALF := 110.0  # half-size of the island (island = 220 x 220)
const SHORE_DEPTH := 3      # rows of water tiles around the island perimeter

# Pre-loaded once, instanced many times
var _straight : PackedScene
var _corner   : PackedScene
var _sea_tile : PackedScene
var _dome     : PackedScene

# ── Lifecycle ──────────────────────────────────────────────────────────────────

func _ready() -> void:
	_preload_assets()
	_build_sea_base()
	_build_sea_shore()
	_build_island()
	_build_road_loop()
	_build_obstacles()


func _preload_assets() -> void:
	if ResourceLoader.exists(STRAIGHT_PATH): _straight = load(STRAIGHT_PATH)
	if ResourceLoader.exists(CORNER_PATH):   _corner   = load(CORNER_PATH)
	if ResourceLoader.exists(SEA_TILE_PATH): _sea_tile = load(SEA_TILE_PATH)
	if ResourceLoader.exists(DOME_PATH):     _dome     = load(DOME_PATH)


# ── Sea ────────────────────────────────────────────────────────────────────────

func _build_sea_base() -> void:
	# One large blue plane — no collision needed (fall detected via y position).
	var mi    := MeshInstance3D.new()
	var plane := PlaneMesh.new()
	plane.size        = Vector2(800.0, 800.0)
	mi.mesh           = plane
	mi.material_override = _mat(Color(0.07, 0.24, 0.76), 0.08)
	add_child(mi)


func _build_sea_shore() -> void:
	# 3 rows of Kenney water tiles ringing the island perimeter.
	# Tile natural orientation: covers [P.x, P.x+T] × [P.z-T, P.z] at y=0.
	var t    := TILE_SIZE
	var ih   := ISLAND_HALF
	var cols := int((ih * 2) / t)   # tiles across one side of the island  ≈ 73

	# North shore (z decreasing away from island, z < -ih)
	for col in cols:
		for row in SHORE_DEPTH:
			_place_tile(_sea_tile,
				Vector3(-ih + col * t,  0.0,  -ih - row * t),
				0.0)

	# South shore (z increasing, z > +ih)
	for col in cols:
		for row in SHORE_DEPTH:
			_place_tile(_sea_tile,
				Vector3(-ih + col * t,  0.0,  ih + (row + 1) * t),
				0.0)

	# West shore (x decreasing, x < -ih)  — runs N-S so rotate 90°
	var rows := cols + SHORE_DEPTH * 2   # extend to cover the corners too
	for col in SHORE_DEPTH:
		for row in rows:
			_place_tile(_sea_tile,
				Vector3(-ih - (col + 1) * t,  0.0,  -ih + row * t + t),
				0.0)

	# East shore (x increasing, x > +ih)
	for col in SHORE_DEPTH:
		for row in rows:
			_place_tile(_sea_tile,
				Vector3(ih + col * t,  0.0,  -ih + row * t + t),
				0.0)


# ── Island ─────────────────────────────────────────────────────────────────────

func _build_island() -> void:
	# Green box; top surface sits at y = 2.0.
	var size := Vector3(ISLAND_HALF * 2.0, 2.0, ISLAND_HALF * 2.0)
	var body := _static_box(Vector3(0.0, 1.0, 0.0), size, Color(0.27, 0.57, 0.17))
	add_child(body)


# ── Road loop ──────────────────────────────────────────────────────────────────

func _build_road_loop() -> void:
	var r    := LOOP_R
	var t    := TILE_SIZE
	var nt   := ROAD_TILES                  # 3 tiles wide
	var half := t * nt / 2.0               # 4.5 — half road width
	var len  := int((r * 2.0) / t)         # 40 — tiles along one straight
	var road_y := 2.0                       # island top surface (tiles sit on top)

	# Each Kenney tile covers [P.x, P.x+t] × [P.z-t, P.z] (natural orientation).
	# For E-W straights: use tiles as-is.
	# For N-S straights: rotate_y(-PI/2) so tile covers [P.x, P.x+t] × [P.z, P.z+t].

	# ── North straight  (centre z = -r, runs E-W) ────────────────────
	for col in len:
		for row in nt:
			var px := -r + col * t
			var pz := -r - half + (row + 1) * t   # rows stack in +Z
			_place_tile(_straight, Vector3(px, road_y, pz), 0.0)

	# ── South straight  (centre z = +r, runs E-W) ────────────────────
	for col in len:
		for row in nt:
			var px := -r + col * t
			var pz :=  r - half + (row + 1) * t
			_place_tile(_straight, Vector3(px, road_y, pz), 0.0)

	# ── East straight   (centre x = +r, runs N-S) ────────────────────
	for row in len:
		for col in nt:
			var px := r - half + col * t           # columns in X
			var pz := -r + row * t                 # rows in +Z (rotation handles it)
			_place_tile(_straight, Vector3(px, road_y, pz), -PI / 2.0)

	# ── West straight   (centre x = -r, runs N-S) ────────────────────
	for row in len:
		for col in nt:
			var px := -r - half + col * t
			var pz := -r + row * t
			_place_tile(_straight, Vector3(px, road_y, pz), -PI / 2.0)

	# ── Corners  (3×3 patch, plain asphalt, no-rotation fills the gap) ─
	for sx in [-r, r]:
		for sz in [-r, r]:
			for col in nt:
				for row in nt:
					var px: float = sx - half + col * t
					var pz: float = sz - half + (row + 1) * t
					_place_tile(_corner, Vector3(px, road_y, pz), 0.0)

	# ── Invisible collision boxes  (one per road section) ─────────────
	# These are what the physics engine and player actually interact with.
	var rh  := 0.4                          # collision box height
	var cy  := road_y + rh / 2.0
	var rw  := nt * t                       # 9.0
	var rln := r * 2.0                      # 120.0 (straights only — corners overlap)

	_add_road_collider(Vector3(  0.0, cy, -r), Vector3(rln, rh, rw))  # North
	_add_road_collider(Vector3(  0.0, cy,  r), Vector3(rln, rh, rw))  # South
	_add_road_collider(Vector3(  r,   cy, 0.0), Vector3(rw, rh, rln))  # East
	_add_road_collider(Vector3( -r,   cy, 0.0), Vector3(rw, rh, rln))  # West
	# Corner collision patches
	for sx in [-r, r]:
		for sz in [-r, r]:
			_add_road_collider(Vector3(sx, cy, sz), Vector3(rw, rh, rw))


func _place_tile(scene: PackedScene, pos: Vector3, rot_y: float) -> void:
	if not scene:
		return  # asset not yet imported; collision still works
	var inst       := scene.instantiate()
	inst.position  = pos
	inst.rotation.y = rot_y
	add_child(inst)


func _add_road_collider(pos: Vector3, size: Vector3) -> void:
	var body  := StaticBody3D.new()
	var col   := CollisionShape3D.new()
	var shape := BoxShape3D.new()
	shape.size = size
	col.shape  = shape
	body.add_child(col)
	body.position = pos
	add_child(body)


# ── Obstacles ──────────────────────────────────────────────────────────────────

func _build_obstacles() -> void:
	var r  := LOOP_R
	# Tile top = 2.0 (island) + 0.63 (Kenney tile height) = 2.63
	# Dome centre = tile_top + half_dome_height ≈ 2.63 + 1.5 = 4.13
	var oy := 4.15

	var positions = [
		# North straight  (z = -r, spread along X)
		Vector3(-30.0, oy, -r), Vector3(-5.0, oy, -r), Vector3(25.0, oy, -r),
		# South straight
		Vector3( 30.0, oy,  r), Vector3( 5.0, oy,  r), Vector3(-25.0, oy,  r),
		# East straight
		Vector3(r, oy, -30.0), Vector3(r, oy,  5.0), Vector3(r, oy,  35.0),
		# West straight
		Vector3(-r, oy,  30.0), Vector3(-r, oy, -5.0), Vector3(-r, oy, -35.0),
	]

	var colors := [
		Color(0.90, 0.10, 0.10),   # red
		Color(1.00, 0.55, 0.00),   # orange
		Color(0.90, 0.85, 0.10),   # yellow
	]

	for i in positions.size():
		_add_obstacle(positions[i], colors[i % colors.size()])


func _add_obstacle(pos: Vector3, fallback_color: Color) -> void:
	var body := StaticBody3D.new()
	body.add_to_group("obstacle")

	if _dome:
		var mesh_node := _dome.instantiate()
		mesh_node.scale = Vector3(0.8, 0.8, 0.8)
		body.add_child(mesh_node)
	else:
		# Fallback: coloured box until GLB is imported
		var mi   := MeshInstance3D.new()
		var bm   := BoxMesh.new()
		bm.size  = Vector3(2.5, 3.0, 2.5)
		mi.mesh  = bm
		mi.material_override = _mat(fallback_color)
		body.add_child(mi)

	var col    := CollisionShape3D.new()
	var shape  := BoxShape3D.new()
	shape.size = Vector3(2.5, 3.0, 2.5)
	col.shape  = shape
	body.add_child(col)

	body.position = pos
	add_child(body)


# ── Helpers ────────────────────────────────────────────────────────────────────

func _static_box(pos: Vector3, size: Vector3, color: Color) -> StaticBody3D:
	var body  := StaticBody3D.new()
	var mi    := MeshInstance3D.new()
	var bm    := BoxMesh.new()
	bm.size   = size
	mi.mesh   = bm
	mi.material_override = _mat(color)
	body.add_child(mi)
	var col   := CollisionShape3D.new()
	var shape := BoxShape3D.new()
	shape.size = size
	col.shape  = shape
	body.add_child(col)
	body.position = pos
	return body


func _mat(color: Color, roughness := 0.85) -> StandardMaterial3D:
	var m          := StandardMaterial3D.new()
	m.albedo_color = color
	m.roughness    = roughness
	return m
