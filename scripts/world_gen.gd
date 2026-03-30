extends Node3D

# ── Asset paths ───────────────────────────────────────────────────────────────
const STRAIGHT_PATH := "res://assets/road_straight.gltf"
const CORNER_PATH   := "res://assets/road_corner.gltf"
const SEA_TILE_PATH := "res://assets/sea_tile.gltf"
const DOME_PATH     := "res://assets/geodesic_dome.glb"

# ── World constants ───────────────────────────────────────────────────────────
const TILE_SIZE   := 3.0
const ROAD_TILES  := 3
const LOOP_R      := 60.0
const ISLAND_HALF := 110.0
const SHORE_DEPTH := 3

var _straight : PackedScene
var _corner   : PackedScene
var _sea_tile : PackedScene
var _dome     : PackedScene

# ⭐ NEW: container for all generated objects
var build_root : Node3D


# ── Lifecycle ─────────────────────────────────────────────────────────────────

func _ready() -> void:
	build_root = Node3D.new()
	build_root.name = "GeneratedWorld"
	add_child(build_root)

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


# ── Sea ───────────────────────────────────────────────────────────────────────

func _build_sea_base() -> void:
	var mi    := MeshInstance3D.new()
	var plane := PlaneMesh.new()
	plane.size = Vector2(800.0, 800.0)
	mi.mesh = plane
	mi.material_override = _mat(Color(0.07, 0.24, 0.76), 0.08)

	build_root.add_child(mi)


func _build_sea_shore() -> void:
	var t    := TILE_SIZE
	var ih   := ISLAND_HALF
	var cols := int((ih * 2) / t)

	for col in cols:
		for row in SHORE_DEPTH:
			_place_tile(_sea_tile,
				Vector3(-ih + col * t, 0.0, -ih - row * t), 0.0)

	for col in cols:
		for row in SHORE_DEPTH:
			_place_tile(_sea_tile,
				Vector3(-ih + col * t, 0.0, ih + (row + 1) * t), 0.0)

	var rows := cols + SHORE_DEPTH * 2
	for col in SHORE_DEPTH:
		for row in rows:
			_place_tile(_sea_tile,
				Vector3(-ih - (col + 1) * t, 0.0, -ih + row * t + t), 0.0)

	for col in SHORE_DEPTH:
		for row in rows:
			_place_tile(_sea_tile,
				Vector3(ih + col * t, 0.0, -ih + row * t + t), 0.0)


# ── Island ────────────────────────────────────────────────────────────────────

func _build_island() -> void:
	var size := Vector3(ISLAND_HALF * 2.0, 2.0, ISLAND_HALF * 2.0)
	var body := _static_box(Vector3(0.0, 1.0, 0.0), size, Color(0.27, 0.57, 0.17))
	build_root.add_child(body)


# ── Road loop ─────────────────────────────────────────────────────────────────

func _build_road_loop() -> void:
	var r := LOOP_R
	var t := TILE_SIZE
	var nt := ROAD_TILES
	var half := t * nt / 2.0
	var len := int((r * 2.0) / t)
	var road_y := 2.0

	for col in len:
		for row in nt:
			var px := -r + col * t
			var pz := -r - half + (row + 1) * t
			_place_tile(_straight, Vector3(px, road_y, pz), 0.0)

	for col in len:
		for row in nt:
			var px := -r + col * t
			var pz := r - half + (row + 1) * t
			_place_tile(_straight, Vector3(px, road_y, pz), 0.0)

	for row in len:
		for col in nt:
			var px := r - half + col * t
			var pz := -r + row * t
			_place_tile(_straight, Vector3(px, road_y, pz), -PI / 2.0)

	for row in len:
		for col in nt:
			var px := -r - half + col * t
			var pz := -r + row * t
			_place_tile(_straight, Vector3(px, road_y, pz), -PI / 2.0)

	for sx in [-r, r]:
		for sz in [-r, r]:
			for col in nt:
				for row in nt:
					var px: float = sx - half + col * t
					var pz: float = sz - half + (row + 1) * t
					_place_tile(_corner, Vector3(px, road_y, pz), 0.0)

	var rh := 0.4
	var cy := road_y + rh / 2.0
	var rw := nt * t
	var rln := r * 2.0

	_add_road_collider(Vector3(0.0, cy, -r), Vector3(rln, rh, rw))
	_add_road_collider(Vector3(0.0, cy, r), Vector3(rln, rh, rw))
	_add_road_collider(Vector3(r, cy, 0.0), Vector3(rw, rh, rln))
	_add_road_collider(Vector3(-r, cy, 0.0), Vector3(rw, rh, rln))

	for sx in [-r, r]:
		for sz in [-r, r]:
			_add_road_collider(Vector3(sx, cy, sz), Vector3(rw, rh, rw))


func _place_tile(scene: PackedScene, pos: Vector3, rot_y: float) -> void:
	if not scene:
		return
	var inst = scene.instantiate()
	inst.position = pos
	inst.rotation.y = rot_y
	build_root.add_child(inst)


func _add_road_collider(pos: Vector3, size: Vector3) -> void:
	var body = StaticBody3D.new()
	var col = CollisionShape3D.new()
	var shape = BoxShape3D.new()
	shape.size = size
	col.shape = shape
	body.add_child(col)
	body.position = pos

	build_root.add_child(body)


# ── Obstacles ─────────────────────────────────────────────────────────────────

func _build_obstacles() -> void:
	var r := LOOP_R
	var oy := 4.15

	var positions = [
		Vector3(-30.0, oy, -r), Vector3(-5.0, oy, -r), Vector3(25.0, oy, -r),
		Vector3(30.0, oy, r), Vector3(5.0, oy, r), Vector3(-25.0, oy, r),
		Vector3(r, oy, -30.0), Vector3(r, oy, 5.0), Vector3(r, oy, 35.0),
		Vector3(-r, oy, 30.0), Vector3(-r, oy, -5.0), Vector3(-r, oy, -35.0),
	]

	var colors = [
		Color(0.90,0.10,0.10),
		Color(1.00,0.55,0.00),
		Color(0.90,0.85,0.10),
	]

	for i in positions.size():
		_add_obstacle(positions[i], colors[i % colors.size()])


func _add_obstacle(pos: Vector3, fallback_color: Color) -> void:
	var body := StaticBody3D.new()
	body.add_to_group("obstacle")

	if _dome:
		var mesh_node := _dome.instantiate()
		mesh_node.scale = Vector3(0.8,0.8,0.8)
		body.add_child(mesh_node)
	else:
		var mi := MeshInstance3D.new()
		var bm := BoxMesh.new()
		bm.size = Vector3(2.5,3.0,2.5)
		mi.mesh = bm
		mi.material_override = _mat(fallback_color)
		body.add_child(mi)

	var col := CollisionShape3D.new()
	var shape := BoxShape3D.new()
	shape.size = Vector3(2.5,3.0,2.5)
	col.shape = shape
	body.add_child(col)

	body.position = pos
	build_root.add_child(body)


# ── Helpers ───────────────────────────────────────────────────────────────────

func _static_box(pos: Vector3, size: Vector3, color: Color) -> StaticBody3D:
	var body := StaticBody3D.new()

	var mi := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = size
	mi.mesh = bm
	mi.material_override = _mat(color)
	body.add_child(mi)

	var col := CollisionShape3D.new()
	var shape := BoxShape3D.new()
	shape.size = size
	col.shape = shape
	body.add_child(col)

	body.position = pos
	return body


func _mat(color: Color, roughness := 0.85) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = color
	m.roughness = roughness
	return m
