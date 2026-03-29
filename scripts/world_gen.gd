## WorldGen — procedurally builds the race world at runtime.
## Attach to a Node3D called "World" inside your main scene.
##
## Layout (top-down):
##   • Large blue sea plane fills the background
##   • Green rectangular island sits just above sea level
##   • Grey road loop runs around the island perimeter
##   • Geodesic dome 3D models (from assets/) used as obstacles on the roads
##   • Coloured box fallbacks used when GLB assets are unavailable
##     (all obstacles added to the "obstacle" group for crash detection)
##
## All measurements are in Godot world-units (metres).
extends Node3D

# ── Tunable constants ──────────────────────────────────────────────────────────

const SEA_SIZE    := 600.0   # sea plane half-extent (visual only, very large)
const ISLAND_SIZE := Vector3(220.0, 2.0, 220.0)
const ROAD_WIDTH  := 14.0
const ROAD_HEIGHT := 0.3
const LOOP_RADIUS := 75.0    # distance from centre to road centreline

# Path to imported GLB asset (Godot auto-imports it on first editor open)
const DOME_SCENE := "res://assets/geodesic_dome.glb"

# ── Lifecycle ──────────────────────────────────────────────────────────────────

func _ready() -> void:
	_build_lighting()
	_build_sea()
	_build_island()
	_build_road_loop()
	_build_obstacles()


# ── Lighting & sky ─────────────────────────────────────────────────────────────

func _build_lighting() -> void:
	var sun := DirectionalLight3D.new()
	sun.shadow_enabled  = true
	sun.light_energy    = 1.3
	# Angle: roughly 45° down from above-right
	sun.rotation_degrees = Vector3(-45.0, -30.0, 0.0)
	add_child(sun)

	var env_node := WorldEnvironment.new()
	var env      := Environment.new()

	var sky     := Sky.new()
	var sky_mat := ProceduralSkyMaterial.new()
	sky_mat.sky_top_color      = Color(0.28, 0.52, 0.93)
	sky_mat.sky_horizon_color  = Color(0.68, 0.84, 1.00)
	sky_mat.ground_bottom_color = Color(0.22, 0.40, 0.14)
	sky.sky_material = sky_mat

	env.background_mode        = Environment.BG_SKY
	env.sky                    = sky
	env.ambient_light_source   = Environment.AMBIENT_SOURCE_SKY
	env.ambient_light_energy   = 0.6
	env_node.environment       = env
	add_child(env_node)


# ── Sea ────────────────────────────────────────────────────────────────────────

func _build_sea() -> void:
	# Visual plane — no collision needed; the player detects the fall by y position.
	var mesh_inst  := MeshInstance3D.new()
	var plane      := PlaneMesh.new()
	plane.size     = Vector2(SEA_SIZE, SEA_SIZE)
	mesh_inst.mesh = plane
	mesh_inst.material_override = _mat(Color(0.07, 0.24, 0.76), 0.08)
	add_child(mesh_inst)
	# Sea sits at y = 0


# ── Island ─────────────────────────────────────────────────────────────────────

func _build_island() -> void:
	# A flat green box just above the sea.
	# Top surface = y 0 + 1 (half height) + 1 (half of 2-unit box) = y 2.0
	var body := _static_box(
		Vector3(0.0, 1.0, 0.0),
		ISLAND_SIZE,
		Color(0.27, 0.57, 0.17)
	)
	add_child(body)


# ── Road loop ──────────────────────────────────────────────────────────────────

func _build_road_loop() -> void:
	# Island top = y 2.0; road centre = island_top + road_height/2
	var ry  := 2.0 + ROAD_HEIGHT * 0.5   # ≈ 2.15
	var r   := LOOP_RADIUS
	var rw  := ROAD_WIDTH
	var rh  := ROAD_HEIGHT

	# Four straight sections — two run east-west, two run north-south
	_add_road(Vector3(  0.0, ry, -r), Vector3(r * 2.0, rh, rw))  # North
	_add_road(Vector3(  0.0, ry,  r), Vector3(r * 2.0, rh, rw))  # South
	_add_road(Vector3(  r,   ry,  0.0), Vector3(rw, rh, r * 2.0))  # East
	_add_road(Vector3( -r,   ry,  0.0), Vector3(rw, rh, r * 2.0))  # West

	# Corner patches — square boxes that stitch the straights together
	for sx in [-r, r]:
		for sz in [-r, r]:
			_add_road(Vector3(sx, ry, sz), Vector3(rw, rh, rw))


func _add_road(pos: Vector3, size: Vector3) -> void:
	var body := _static_box(pos, size, Color(0.21, 0.21, 0.21))
	add_child(body)


# ── Obstacles ──────────────────────────────────────────────────────────────────
#
# Placed along each straight so the player must steer around them.
# Each obstacle is added to the "obstacle" group — the player script
# can check  collider.is_in_group("obstacle")  to trigger a crash.

func _build_obstacles() -> void:
	var r   := LOOP_RADIUS
	# Road top = island top + road height = 2.0 + 0.3 = 2.3
	# Obstacle box is 3 units tall → centre at road_top + 1.5 = 3.8
	var oy  := 3.8
	var col := [
		Color(0.90, 0.10, 0.10),   # red
		Color(1.00, 0.55, 0.00),   # orange
		Color(0.90, 0.85, 0.10),   # yellow
	]

	var positions: Array[Vector3] = [
		# North straight (z ≈ -75, vary x)
		Vector3(-35.0, oy, -r),
		Vector3( -8.0, oy, -r),
		Vector3( 28.0, oy, -r),

		# South straight (z ≈ +75, vary x)
		Vector3( 35.0, oy,  r),
		Vector3(  5.0, oy,  r),
		Vector3(-28.0, oy,  r),

		# East straight (x ≈ +75, vary z)
		Vector3(r, oy, -38.0),
		Vector3(r, oy,   8.0),
		Vector3(r, oy,  45.0),

		# West straight (x ≈ -75, vary z)
		Vector3(-r, oy,  38.0),
		Vector3(-r, oy,  -8.0),
		Vector3(-r, oy, -45.0),
	]

	for i in positions.size():
		_add_obstacle(positions[i], col[i % col.size()])


func _add_obstacle(pos: Vector3, _color: Color) -> void:
	var body := StaticBody3D.new()
	body.add_to_group("obstacle")

	# Try to load the geodesic dome GLB; fall back to a coloured box if not yet imported.
	if ResourceLoader.exists(DOME_SCENE):
		var dome_scene : PackedScene = load(DOME_SCENE)
		var dome       := dome_scene.instantiate()
		# Scale the dome down to a sensible obstacle size (~3 m tall)
		dome.scale = Vector3(0.8, 0.8, 0.8)
		body.add_child(dome)
	else:
		# Fallback box (same colour scheme as before)
		var mesh_inst := MeshInstance3D.new()
		var box_mesh  := BoxMesh.new()
		box_mesh.size = Vector3(2.5, 3.0, 2.5)
		mesh_inst.mesh = box_mesh
		mesh_inst.material_override = _mat(_color)
		body.add_child(mesh_inst)

	# Collision is always a simple box — fast and reliable for kart physics
	var col    := CollisionShape3D.new()
	var shape  := BoxShape3D.new()
	shape.size = Vector3(2.5, 3.0, 2.5)
	col.shape  = shape
	body.add_child(col)

	body.position = pos
	add_child(body)


# ── Helpers ────────────────────────────────────────────────────────────────────

## Creates a StaticBody3D cube with a matching CollisionShape3D and coloured mesh.
func _static_box(pos: Vector3, size: Vector3, color: Color) -> StaticBody3D:
	var body      := StaticBody3D.new()

	var mesh_inst := MeshInstance3D.new()
	var box_mesh  := BoxMesh.new()
	box_mesh.size            = size
	mesh_inst.mesh           = box_mesh
	mesh_inst.material_override = _mat(color)
	body.add_child(mesh_inst)

	var col       := CollisionShape3D.new()
	var shape     := BoxShape3D.new()
	shape.size    = size
	col.shape     = shape
	body.add_child(col)

	body.position = pos
	return body


func _mat(color: Color, roughness := 0.85) -> StandardMaterial3D:
	var m       := StandardMaterial3D.new()
	m.albedo_color = color
	m.roughness    = roughness
	return m
