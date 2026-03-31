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
# - Obstacles   : Houses, bushes, animals(?)
#
# Lighting / sky are handled in the scene, not here.
extends Node3D

# ── Asset paths (Godot auto-imports on first editor open) ──────────────────────
const SEA_TILE_PATH := "res://assets/sea_tile.gltf"        # tile_001: water surface

# ── World constants ────────────────────────────────────────────────────────────
const TILE_SIZE   := 3.0    # all Kenney road tiles are 3 × 3 units
const ROAD_TILES  := 3      # tiles wide per road section -> 9 units total
const LOOP_R      := 60.0   # road centreline distance from world centre
const ISLAND_HALF := 110.0  # half-size of the island (island = 220 x 220)
const SHORE_DEPTH := 3      # rows of water tiles around the island perimeter

# Pre-loaded once, instanced many times
var _sea_tile : PackedScene

# ── Lifecycle ──────────────────────────────────────────────────────────────────

func _ready() -> void:
	_preload_assets()
	_build_sea_base()


func _preload_assets() -> void:
	if ResourceLoader.exists(SEA_TILE_PATH): _sea_tile = load(SEA_TILE_PATH)

# ── Sea ────────────────────────────────────────────────────────────────────────

func _build_sea_base() -> void:
	# One large blue plane — no collision needed (fall detected via y position).
	var mi    := MeshInstance3D.new()
	var plane := PlaneMesh.new()
	plane.size        = Vector2(800.0, 800.0)
	mi.mesh           = plane
	mi.material_override = _mat(Color(0.07, 0.24, 0.76), 0.08)
	add_child(mi)








# ── Obstacles ──────────────────────────────────────────────────────────────────





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
