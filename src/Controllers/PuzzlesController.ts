import { Puzzle, PuzzleCompleteData } from "@prisma/client";
import { Request, Response } from "express";
import { client } from "../prisma/client";
import { AppError } from "../Errors/AppError";
import difficultyRanges from "../utils/difficultyRanges";
import difficultyLabels from "../utils/difficultyLabels";

type category =
  | "official"
  | "top-rated"
  | "new"
  | "easy"
  | "medium"
  | "hard"
  | "mine"
  | "completed";

type PuzzleMetadata = Omit<Puzzle, "data"> & {
  completed: boolean;
  liked: boolean;
};

type PuzzleSubmit = Pick<
  Puzzle,
  "shortKey" | "title" | "data" | "description" | "minimumComponents"
>;

type PuzzleSearch = {
  searchTerm: string;
  duration: "short" | "medium" | "long" | "any";
  includeCompleted: boolean;
  difficulty: "easy" | "medium" | "hard" | "any";
};

type Difficulty = 1 | 2 | 3;

class PuzzlesController {
  async list(request: Request, response: Response) {
    const category = request.params.category as category;
    const userId = response.locals.userId;

    switch (category) {
      case "official":
        const officialPuzzles = await client.puzzle.findMany({
          where: {
            user: null,
          },
        });
        return response.json(await onlyMetadata(officialPuzzles, userId));

      case "completed":
        const completedPuzzles = await client.puzzle.findMany({
          where: {
            completionsData: {
              some: {
                userId,
                completed: true,
              },
            },
          },
        });
        return response.json(await onlyMetadata(completedPuzzles, userId));

      case "mine":
        const myPuzzles = await client.puzzle.findMany({
          where: {
            author: userId,
          },
        });
        return response.json(await onlyMetadata(myPuzzles, userId));

      case "new":
        const newPuzzles = await client.puzzle.findMany({
          orderBy: {
            createdAt: "desc",
          },
        });
        return response.json(await onlyMetadata(newPuzzles, userId));

      case "top-rated":
        const topRatedPuzzles = await client.puzzle.findMany({
          orderBy: {
            likes: "desc",
          },
        });
        return response.json(await onlyMetadata(topRatedPuzzles, userId));

      case "easy":
      case "medium":
      case "hard":
        const range = difficultyRanges[category];
        const puzzlesByDificulty = await client.puzzle.findMany({
          where: {
            difficulty: {
              gte: range["min"],
              lt: range["max"],
            },
          },
        });
        return response.json(await onlyMetadata(puzzlesByDificulty, response.locals.userId));

      default:
        throw new Error("Invalid category!");
    }
  }

  async search(request: Request, response: Response) {
    const { searchTerm, duration, difficulty, includeCompleted } =
      request.body as PuzzleSearch;

    const puzzles = await client.puzzle.findMany({
      where: {
        OR: [
          {
            title: {
              contains: searchTerm as string,
            },
          },
          {
            description: {
              contains: searchTerm as string,
            },
          },
        ],
      },
    });

    if (!puzzles) {
      return response.status(404).send();
    }

    let metadata = await onlyMetadata(puzzles, response.locals.userId);
    if (!includeCompleted) {
      metadata = metadata.filter((puzzle) => puzzle.completed === false);
    }

    // TODO filter in the query
    if (difficulty && difficulty !== "any") {
      const range = difficultyRanges[difficulty];
      metadata = metadata.filter(
        (puzzle) =>
          puzzle.difficulty &&
          puzzle.difficulty >= range["min"] &&
          puzzle.difficulty < range["max"]
      );
    }

    if (duration && duration !== "any") {
      metadata = metadata.filter((puzzle) => {
        if (puzzle.averageTime) {
          switch (duration) {
            case "short":
              return puzzle.averageTime < 120;
            case "long":
              return puzzle.averageTime > 600;
            default:
              return puzzle.averageTime >= 120 && puzzle.averageTime <= 600;
          }
        }
      });
    }

    return response.json(metadata);
  }

  async report(request: Request, response: Response) {
    const puzzleId = request.params.puzzleId;

    // verify if request.body has reason
    const reason = request.body.reason;

    if (!reason) {
      return response.status(400).send("Missing reason");
    }

    const report = await client.puzzleReport.create({
      data: {
        puzzleId: +puzzleId,
        userId: response.locals.userId,
        reason: request.body.reason,
      },
    });

    if (!report) {
      return response.status(500).send("Failed to report puzzle");
    }

    return response.status(201).json(report);
  }

  async submit(request: Request, response: Response) {
    const { shortKey, title, data, description, minimumComponents } =
      request.body as PuzzleSubmit;

    const user = await client.user.findUnique({
      where: {
        id: response.locals.userId,
      },
    });

    // Never should happen
    if (user === null) {
      throw new AppError("Authentication inconsistency!", 401);
    }

    const puzzle = await client.puzzle.create({
      data: {
        shortKey,
        title,
        data,
        author: user.id,
        authorName: user.name,
        description: "placeholder",
        minimumComponents: 1,
        minimumNands: 1,
      },
    });

    return response.status(201).json(puzzle);
  }

  async complete(request: Request, response: Response) {
    const puzzleId: number = +request.params.puzzleId;

    const puzzle = await findPuzzleById(puzzleId);

    if (!puzzle) {
      return response.status(404).send();
    }

    const userId = response.locals.userId;

    const {
      time,
      liked,
      componentsUsed = 0,
      nandsUsed = 0,
      difficultyRating,
    } = request.body;

    const previousCompleteData = (await findPuzzleCompleteData(puzzleId, userId))!;

    // In reality, we only have one
    const completeData = await client.puzzleCompleteData.updateMany({
      where: {
        puzzleId,
        userId,
      },
      data: {
        timeTaken: time,
        liked,
        componentsUsed,
        nandsUsed,
        difficultyRating,
        completed: true,
      },
    });

    let likes = puzzle.likes;
    let completions = puzzle.completions;
    let averageTime = puzzle.averageTime;
    let averageDifficultyRating = puzzle.averageDifficultyRating;

    if (!previousCompleteData.completed) {
      averageTime = calculateNewAverage(puzzle.averageTime, puzzle.completions, time);
      averageDifficultyRating = calculateNewAverage(puzzle.averageDifficultyRating, puzzle.completions, difficultyRating);

      likes += liked ? 1 : 0;
      completions++;
    }
    else {
      averageDifficultyRating = recalculateAverage(averageDifficultyRating!, puzzle.completions, previousCompleteData.difficultyRating, difficultyRating);
      
      if (previousCompleteData.liked && !liked) {
        likes--;
      }
      else if (!previousCompleteData.liked && liked) {
        likes++;
      }
    }
  
    await client.puzzle.update({
      where: {
        id: puzzleId,
      },
      data: {
        likes,
        completions,
        averageTime,
        averageDifficultyRating,
        difficulty: calculateDifficulty(averageTime!, averageDifficultyRating),
      },
    });

    return response.json(completeData);
  }

  async download(request: Request, response: Response) {
    const puzzleId = +request.params.puzzleId;

    const puzzle = await findPuzzleById(puzzleId);

    if (!puzzle) {
      return response.status(404).send();
    }

    const userId = response.locals.userId;
    const completeData = await findPuzzleCompleteData(puzzleId, userId);

    if (!completeData) {
      await client.puzzleCompleteData.create({
        data: {
          userId,
          puzzleId,
        },
      });

      puzzle.downloads++;

      await client.puzzle.update({
        where: {
          id: puzzleId,
        },
        data: {
          downloads: puzzle.downloads,
        },
      });
    }

    const { data, ...metaData } = puzzle;

    let difficultyRating: string | null = null;

    if (completeData !== null && completeData.difficultyRating !== null) {
      difficultyRating = difficultyLabels[completeData.difficultyRating];
    }

    return response.json({
      game: data,
      meta: {
        ...metaData,
        liked: completeData?.liked,
        difficultyRating,
      },
    });
  }

  async delete(request: Request, response: Response) {
    const puzzleId = +request.params.puzzleId;
    const user = response.locals.userId;

    const puzzle = await client.puzzle.findFirst({
      where: {
        id: puzzleId,
        author: user,
      },
    });

    if (!puzzle) {
      return response.json({ success: false });
    }

    await client.puzzle.delete({
      where: {
        id: puzzleId,
      },
    });

    return response.json({ success: true });
  }
}

function findPuzzleCompleteData(puzzleId: number, userId: string): Promise<PuzzleCompleteData | null> {
  return client.puzzleCompleteData.findFirst({
    where: {
      puzzleId,
      userId,
    },
  });
}

// TODO maybe get metadata by joins, or at least fetch all puzzles at once
function onlyMetadata(puzzles: Puzzle[], userId: string): Promise<PuzzleMetadata[]> {
  return Promise.all(
    puzzles.map(async (puzzle) => {
      const completeData = await findPuzzleCompleteData(puzzle.id, userId);

      const { data, ...incompleteData } = puzzle;
      const metaData = incompleteData as PuzzleMetadata;

      if (completeData) {
        metaData.completed = completeData.completed;
        metaData.liked = completeData.liked;
      } else {
        metaData.completed = false;
        metaData.liked = false;
      }

      return metaData;
    })
  );
}

function findPuzzleById(puzzleId: number): Promise<Puzzle | null> {
  return client.puzzle.findFirst({
    where: {
      id: puzzleId,
    },
  });
}

function calculateNewAverage(oldAverage: number | null, oldTotal: number, newValue: number | null): number | null {
  if (oldAverage === null) {
    return newValue;
  }
  if (newValue === null) {
    return oldAverage;
  }
  return (oldAverage * oldTotal + newValue) / (oldTotal + 1);
}

function recalculateAverage(oldAverage: number | null, total: number, oldValue: number | null, newValue: number | null): number | null {
  if (oldAverage === null) {
    return newValue;
  }
  if (newValue === null || oldValue == newValue) {
    return oldAverage;
  }
  if (oldValue === null) {
    oldValue = oldAverage;
  }
  return oldAverage - oldValue / total + newValue / total;
}

// Needs to return a number between 0 and 1 no matter the inputs
function calculateDifficulty(averageTime: number, averageDifficulty: number | null): number {
  if (averageDifficulty === null) {
    averageDifficulty = 0;
  }
  return (1 / (1 + (Math.pow(Math.E, - (averageTime) / 300))) - 0.5) + averageDifficulty / 4;
}

export { PuzzlesController };
